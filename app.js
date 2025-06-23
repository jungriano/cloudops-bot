const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const bodyParser = require('body-parser');
const { createEventAdapter } = require('@slack/events-api');
const { WebClient, LogLevel } = require('@slack/web-api');
const axios = require('axios');
const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const util = require('util');

// Setup logging to a file
const logStream = fs.createWriteStream('slackbot-app.log', { flags: 'a' });
console.log = (message) => {
  logStream.write(`[INFO] ${util.format(message)}\n`);
  process.stdout.write(util.format(message) + '\n');
};
console.error = (message) => {
  logStream.write(`[ERROR] ${util.format(message)}\n`);
  process.stderr.write(util.format(message) + '\n');
};

// Create a Winston logger instance
const logger = createLogger({
  level: 'debug',
  format: format.combine(
    format.label({ label: 'slackbot' }),
    format.timestamp(),
    format.printf(({ level, message, label, timestamp }) => {
      return `${timestamp} [${label}] ${level}: ${message}`;
    })
  ),
  transports: [new transports.File({ filename: 'slackbot-app.log' })],
});

// Setup AWS Secrets Manager client
const client = new SecretsManagerClient({ region: 'us-east-1' });

// Load secrets from AWS Secrets Manager and set them as environment variables
async function loadSecrets() {
  const secretName = 'cloudops-bot-secrets';
  try {
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const data = await client.send(command);
    if (data.SecretString) {
      const secrets = JSON.parse(data.SecretString);
      process.env.SLACK_SIGNING_SECRET = secrets.SLACK_SIGNING_SECRET;
      process.env.SLACK_TOKEN = secrets.SLACK_TOKEN;
      process.env.PERSONAL_ACCESS_TOKEN = secrets.PERSONAL_ACCESS_TOKEN;
    }
  } catch (error) {
    console.error('Error loading secrets from AWS:', error);
    throw error;
  }
}

(async () => {
  try {
    // Load secrets before initializing the app
    await loadSecrets();

    const {
      SLACK_SIGNING_SECRET,
      SLACK_TOKEN,
      ADO_ORGANIZATION,
      PROJECT_NAME,
      PERSONAL_ACCESS_TOKEN,
      AREA_PATH,
      SLACK_WORKSPACE_URL,
      CHANNEL_ID,
      WORK_ITEM_ID,
    } = process.env;

    // Azure DevOps work item relation value
    const relationsValue = {
      rel: 'System.LinkTypes.Hierarchy-Reverse',
      url: `https://thycotic.visualstudio.com/CloudEngineering/_workitems/edit/${WORK_ITEM_ID}`,
    };

    // Initialize Slack event adapter and Express app
    const slackEvents = createEventAdapter(SLACK_SIGNING_SECRET);
    const app = express();
    const web = new WebClient(SLACK_TOKEN, { logLevel: LogLevel.DEBUG });

    app.use('/slack/events', slackEvents.requestListener());
    app.use(bodyParser.json());

    const processedThreads = new Set();
    const workItemMapping = {};

    // Convert Slack-specific text formatting to standard HTML formatting
    async function convertSlackFormatting(text) {
      const userMentions = text.match(/<@U[A-Z0-9]+>/g) || [];
      for (const mention of userMentions) {
        const userId = mention.slice(2, -1);
        const userInfo = await web.users.info({ user: userId });
        const userName = userInfo.user.profile.display_name || userInfo.user.profile.real_name;
        text = text.replace(mention, `@${userName}`);
      }

      const urlMatches = text.match(/<([^|>]+)(?:\|([^>]+))?>/g) || [];
      for (const match of urlMatches) {
        const [ , url, label ] = match.match(/<([^|>]+)(?:\|([^>]+))?>/);
        if (label) {
          text = text.replace(match, `<a href="${url}">${label}</a>`);
        } else {
          text = text.replace(match, `<a href="${url}">${url}</a>`);
        }
      }

      text = text.replace(/`([^`]+)`/g, '`$1`');
      text = text.replace(/```([^`]+)```/gs, '```\n$1\n```');

      return text;
    }

    // Update the state of a work item to "Completed" in Azure DevOps
    async function updateWorkItemState(workItemId) {
      const updatePayload = [{ op: 'add', path: '/fields/System.State', value: 'Completed' }];

      logger.debug(`Updating work item ID ${workItemId} to state "Completed"`);

      await axios.patch(
        `https://dev.azure.com/${ADO_ORGANIZATION}/${PROJECT_NAME}/_apis/wit/workitems/${workItemId}?api-version=6.1`,
        updatePayload,
        {
          headers: {
            'Content-Type': 'application/json-patch+json',
            'Authorization': `Basic ${Buffer.from(':' + PERSONAL_ACCESS_TOKEN).toString('base64')}`,
          },
        }
      );

      logger.debug(`Work item ID ${workItemId} updated to state "Completed"`);
    }

    // Handle Slack reaction_added event
    slackEvents.on('reaction_added', async (event) => {
      const { item, reaction, user } = event;

      const message = await web.conversations.history({
        channel: item.channel,
        latest: item.ts,
        inclusive: true,
        limit: 1,
      });

      const threadId = message.messages[0].thread_ts || item.ts;

      if (item.ts === threadId) {
        if (reaction === 'eyes') {
          if (!processedThreads.has(threadId)) {
            try {
              processedThreads.add(threadId);

              const userId = message.messages[0].user;
              const userInfo = await web.users.info({ user: userId });
              const messageSenderFullName = userInfo.user.profile.real_name;

              const reactingUserInfo = await web.users.info({ user });
              const reactingUserFullName = reactingUserInfo.user.profile.real_name;

              const originalText = message.messages[0].text;
              const text = await convertSlackFormatting(originalText);

              const description = `${text.replace(/\n/g, '<br>')}<br><br>Slack Conversation: <a href="${SLACK_WORKSPACE_URL}/${CHANNEL_ID}/p${threadId}">${SLACK_WORKSPACE_URL}/${CHANNEL_ID}/p${threadId}</a><br>`;
              const title = `Azure Support Request from ${messageSenderFullName}`;
              const currentIteration = await getCurrentIteration();
              const workItemPayload = [
                { op: 'add', path: '/fields/System.Title', value: title },
                { op: 'add', path: '/fields/System.Description', value: description },
                { op: 'add', path: '/fields/System.AreaPath', value: AREA_PATH },
                { op: 'add', path: '/fields/System.AssignedTo', value: reactingUserFullName },
                { op: 'add', path: '/relations/-', value: relationsValue },
                { op: 'add', path: '/fields/System.IterationPath', value: currentIteration.path },
              ];

              const response = await axios.patch(
                `https://dev.azure.com/${ADO_ORGANIZATION}/${PROJECT_NAME}/_apis/wit/workitems/$User%20Story?api-version=6.1`,
                workItemPayload,
                {
                  headers: {
                    'Content-Type': 'application/json-patch+json',
                    'Authorization': `Basic ${Buffer.from(':' + PERSONAL_ACCESS_TOKEN).toString('base64')}`,
                  },
                }
              );

              const workItemNumber = response.data.id;
              const workItemURL = `https://dev.azure.com/${ADO_ORGANIZATION}/${PROJECT_NAME}/_workitems/edit/${workItemNumber}`;

              workItemMapping[threadId] = workItemNumber;

              await web.chat.postMessage({
                channel: item.channel,
                thread_ts: threadId,
                text: `Work item created for this concern: <${workItemURL}|${workItemNumber}>`,
              });

              logger.debug('Work item created:', workItemNumber);
            } catch (error) {
              logger.error('Error:', error);
            }
          }
        } else if (reaction === 'key') {
          try {
            const message = await web.conversations.history({
              channel: item.channel,
              latest: item.ts,
              inclusive: true,
              limit: 1,
            });

            const userId = message.messages[0].user;
            const userInfo = await web.users.info({ user: userId });
            const displayName = userInfo.user.profile.display_name || userInfo.user.profile.real_name;

            await web.chat.postMessage({
              channel: item.channel,
              thread_ts: item.ts,
              text: `Hey <@${userId}>, CloudOps team will address your concern asap.`,
            });

            logger.debug(`Replied to user ${displayName}.`);
          } catch (error) {
            logger.error('Error:', error);
          }
        } else if (['white_check_mark', 'checkered_flag'].includes(reaction)) {
          try {
            logger.debug(`${reaction} reaction added to thread ID: ${threadId}`);

            const workItemId = workItemMapping[threadId];

            if (workItemId) {
              await updateWorkItemState(workItemId);

              await web.chat.postMessage({
                channel: item.channel,
                thread_ts: threadId,
                text: `Ticket has been closed!`,
              });

              logger.debug(`Work item ${workItemId} marked as Completed.`);
            } else {
              logger.debug(`No work item found for thread ID: ${threadId}`);
            }
          } catch (error) {
            logger.error('Error:', error);
          }
        }
      }
    });

    // Fetch the current iteration path from Azure DevOps
    async function getCurrentIteration() {
      try {
        const response = await axios.get(
          `https://dev.azure.com/${ADO_ORGANIZATION}/${PROJECT_NAME}/_apis/work/teamsettings/iterations`,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Basic ${Buffer.from(':' + PERSONAL_ACCESS_TOKEN).toString('base64')}`,
            }
          }
        );

        const currentIteration = response.data.value.find(
          (iteration) => iteration.attributes.timeFrame === 'current'
        );

        return currentIteration;
      } catch (error) {
        logger.error('Error fetching current iteration:', error);
        throw error;
      }
    }

    // Start the Express server
    app.listen(3000, () => {
      console.log('Server is running on http://localhost:3000');
    });
  } catch (error) {
    console.error('Failed to start the server:', error);
  }
})();