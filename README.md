# cloudops-bot
The CloudOps-Bot  is a slack application written in JavaScript and is executed in a Node.js environment. It servers as a middleware between Slack and ADO to streamline collaboration and task tracking. 

Application Details
Application Name: CloudOps-Bot
Creator: Joy Ungriano
Deployment Environment: 
Server named: cloudops-bot-server
Application path:  /home/cloudops-bot-app/

Slack Event Subscription URL:  https://api..com/apps/A05TQ3E9CDQ/event-subscriptions?

Features
Automatic Work Item Creation: When someone drops an access request in the #slack-channel and the admin reacted with 👀 emoji,  the bot detects the request and creates a corresponding work item in Azure DevOps.

User Notification: Upon successful creation of a work item, the bot notifies the channel with the details and provides a link to the newly created work item.

Reaction Handling: The bot responds to specific reactions on Slack messages. For example:
Reacting with the 👀 emoji triggers the creation of a work item.
Reacting with the 🔑 emoji acknowledges the user's request.

Reacting with the 
image-20241216-074402.png
 (checkered_flag) or 
image-20241216-074548.png
 (white_check_mark) emoji closes the created ADO work item.

 

Usage Instructions
Access Request Submission:
Drop your access request in the #slack channel.
Ensure to include all necessary details related to the access request.

Work Item Creation:
The CloudOps Bot automatically detects access requests and creates corresponding work items in Azure DevOps.
Upon successful creation, the bot notifies the channel with the work item details and a link to access it.

Acknowledgment:
If you receive an access request and are working on addressing it, react to the message with the 🔑 emoji to acknowledge the user's request or 👀 emoji to create a work item.

Notification:
The bot will send a notification to the channel once a work item is created, providing visibility to all members.
