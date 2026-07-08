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

function formatMentionableValues(selectedValues = [], resolved = {}) {
  if (!Array.isArray(selectedValues) || selectedValues.length === 0) {
    return '';
  }

  return selectedValues
    .map((id) => {
      if (resolved.users?.[id]) return `<@${id}>`;
      if (resolved.roles?.[id]) return `<@&${id}>`;
      return id;
    })
    .join(' ');
}

function collectModalValues(components = []) {
  const values = {};

  for (const component of components) {
    if (component?.type === MessageComponentTypes.ACTION_ROW) {
      const input = component.components?.[0];
      if (input?.custom_id) {
        values[input.custom_id] = input.value ?? '';
      }
      continue;
    }

    if (component?.type === 18 && component.component?.custom_id) {
      const child = component.component;
      if (child.type === MessageComponentTypes.MENTIONABLE_SELECT) {
        values[child.custom_id] = child.values ?? [];
      } else if (child.type === MessageComponentTypes.INPUT_TEXT) {
        values[child.custom_id] = child.value ?? '';
      }
    }
  }

  return values;
}

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
          type: 18,
          label: 'Band',
          component: {
            type: MessageComponentTypes.MENTIONABLE_SELECT,
            custom_id: 'event_band',
            placeholder: 'Select band members',
            min_values: 1,
            max_values: 25,
            required: true,
          },
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
          const values = collectModalValues(data.components);
          console.log('Modal submitted:', values);

          const eventDateTime = `${values.event_date}T${values.event_time}:00Z`;
          const mentionText = formatMentionableValues(values.event_band, data.resolved || {});
          const startTime = new Date(eventDateTime);
          
          if (Number.isNaN(startTime.getTime())) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: 64,
                content: 'Invalid date/time format. Use YYYY-MM-DD for date and HH:MM for time.',
              },
            });
          }

          // Validate event is in the future
          if (startTime <= new Date()) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: 64,
                content: `❌ Event time must be in the future. You submitted: ${eventDateTime} (UTC)\n\nCurrent time: ${new Date().toISOString()}`,
              },
            });
          }

          if (!guildId) {
            return res.status(400).json({ error: 'Guild ID required to create events.' });
          }

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
            // Step 1: Create the Discord event
            const eventRes = await DiscordRequest(`guilds/${guildId}/scheduled-events`, {
              method: 'POST',
              body: eventBody,
            });
            const eventData = await eventRes.json();
            const eventUrl = `https://discord.com/events/${guildId}/${eventData.id}`;

            // Step 2: Post discussion to #all-events forum channel
            const eventsChannelId = process.env.EVENTS_CHANNEL_ID;
            if (eventsChannelId) {
              const discussionContent = 
                `📅 **${values.event_title}**\n\n ${mentionText ? `🎵 Band: ${mentionText}\n` : ''} 📍 Location: ${values.event_location}\n🕐 Time: ${values.event_date} at ${values.event_time} UTC\n\n [Join Service](${eventUrl})`;

              try {
                const threadRes = await DiscordRequest(`channels/${eventsChannelId}/threads`, {
                  method: 'POST',
                  body: {
                    name: values.event_title,
                    auto_archive_duration: 10080,
                    type: 11, // GUILD_PUBLIC_THREAD
                    message: {
                      content: discussionContent,
                    },
                  },
                });
                const threadData = await threadRes.json();
                console.log('Forum post created:', threadData);
              } catch (forumErr) {
                console.error('Failed to create forum post:', forumErr);
              }
            }

            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `✅ Event created!\n• **${eventData.name}**\n• Location: ${values.event_location}\n• Starts: ${eventData.scheduled_start_time}${mentionText ? `\n• Band: ${mentionText}` : ''}`,
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
