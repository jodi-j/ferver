import 'dotenv/config';
import express from 'express';
import {
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { DiscordRequest } from './utils.js';

const app = express();
const PORT = process.env.PORT || 3000;

function getCreateEventModal() {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: 'create_event_modal',
      title: 'Create an Event',
      components: [
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.INPUT_TEXT,
              custom_id: 'event_title',
              style: 1,
              label: 'Event title',
              placeholder: 'Title',
              required: true,
            },
          ],
        },
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.INPUT_TEXT,
              custom_id: 'event_location',
              style: 1,
              label: 'Location',
              placeholder: 'Location',
              required: true,
            },
          ],
        },
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.INPUT_TEXT,
              custom_id: 'event_date',
              style: 1,
              label: 'Date (YYYY-MM-DD)',
              placeholder: 'YYYY-MM-DD',
              required: true,
            },
          ],
        },
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.INPUT_TEXT,
              custom_id: 'event_time',
              style: 1,
              label: 'Time (UTC HH:MM)',
              placeholder: '00:00',
              required: true,
            },
          ],
        },
      ],
    },
  };
}


app.post(
  '/interactions',
  express.raw({ type: '*/*' }),
  verifyKeyMiddleware(process.env.PUBLIC_KEY),
  async function (req, res) {
    try {
      const body = Buffer.isBuffer(req.body)
        ? JSON.parse(req.body.toString('utf8'))
        : req.body;
      const { type, data, guild_id: guildId, member, user } = body;
      const userId = member?.user?.id ?? user?.id;

      if (type === InteractionType.PING) {
        return res.send({ type: InteractionResponseType.PONG });
      }

      if (type === InteractionType.APPLICATION_COMMAND) {
        const { name } = data;

        if (name === 'create-event') {
          return res.send(getCreateEventModal());
        }

        if (name === 'test') {
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: 'hello world' },
          });
        }

        console.error(`unknown command: ${name}`);
        return res.status(400).json({ error: 'unknown command' });
      }

      if (type === InteractionType.MODAL_SUBMIT) {
        const modalId = data.custom_id;

        if (modalId === 'create_event_modal') {
          const values = {};
          for (const action of data.components) {
            const input = action.components[0];
            values[input.custom_id] = input.value;
          }

          const eventDateTime = `${values.event_date}T${values.event_time}:00.000Z`;
          if (Number.isNaN(Date.parse(eventDateTime))) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: 64,
                content: 'Invalid date/time format. Use YYYY-MM-DD for date and HH:MM for time.',
              },
            });
          }

          if (!guildId) {
            return res.status(400).json({ error: 'Guild ID required to create events.' });
          }

          const startTime = new Date(eventDateTime);
          const eventBody = {
            name: values.event_title,
            scheduled_start_time: startTime.toISOString(),
            scheduled_end_time: new Date(startTime.getTime() + 60 * 60 * 1000).toISOString(),
            privacy_level: 2,
            entity_type: 3,
            description: `Location: ${values.event_location}`,
            entity_metadata: { location: values.event_location },
          };

          try {
            const eventRes = await DiscordRequest(`guilds/${guildId}/scheduled-events`, {
              method: 'POST',
              body: eventBody,
            });
            const eventData = await eventRes.json();

            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `✅ Event created!\n• **${eventData.name}**\n• Location: ${values.event_location}\n• Starts: ${eventData.scheduled_start_time}`,
              },
            });
          } catch (err) {
            console.error(err);
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: 64,
                content: `Failed to create event: ${err.message}`,
              },
            });
          }
        }
      }

      console.error('unknown interaction type', type);
      return res.status(400).json({ error: 'unknown interaction type' });
    } catch (err) {
      console.error('interaction error', err);
      return res.status(500).json({ error: 'internal error' });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
