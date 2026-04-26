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
              label: 'Time (ET HH:MM AM/PM)',
              placeholder: '10:30 AM',
              required: true,
            },
          ],
        },
      ],
    },
  };
}

function parseEasternDateTime(dateString, timeString) {
  const dateMatch = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(dateString);
  const timeMatch = /^([1-9]|1[0-2]):([0-5][0-9])\s*(AM|PM)$/i.exec(timeString.trim());
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const period = timeMatch[3].toUpperCase();

  if (period === 'PM' && hour !== 12) {
    hour += 12;
  } else if (period === 'AM' && hour === 12) {
    hour = 0;
  }

  const offsetMillis = getEasternOffsetMillis(year, month, day);
  if (offsetMillis === null) return null;

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute) - offsetMillis;
  return new Date(utcMillis);
}

function getEasternOffsetMillis(year, month, day) {
  const sampleUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
  });

  const parts = formatter.formatToParts(new Date(sampleUtc));
  const offsetPart = parts.find((part) => part.type === 'timeZoneName');
  if (!offsetPart) return null;

  const offsetMatch = /^GMT([+-]\d{1,2})(?::?(\d{2}))?$/.exec(offsetPart.value);
  if (!offsetMatch) return null;

  const sign = offsetMatch[1].startsWith('-') ? -1 : 1;
  const hours = Math.abs(Number(offsetMatch[1]));
  const minutes = offsetMatch[2] ? Number(offsetMatch[2]) : 0;
  return sign * (hours * 60 + minutes) * 60_000;
}

function formatEasternTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date) + ' ET';
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

          const startTime = parseEasternDateTime(values.event_date, values.event_time);
          if (!startTime || Number.isNaN(startTime.getTime())) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: 64,
                content: 'Invalid date/time format. Use YYYY-MM-DD for date and HH:MM AM/PM for Eastern time.',
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
            const eventRes = await DiscordRequest(`guilds/${guildId}/scheduled-events`, {
              method: 'POST',
              body: eventBody,
            });
            const eventData = await eventRes.json();

            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                embeds: [
                  {
                    title: eventData.name,
                    description: values.event_location,
                    fields: [
                      {
                        name: 'Date',
                        value: values.event_date,
                        inline: true,
                      },
                      {
                        name: 'Call Time',
                        value: formatEasternTime(startTime),
                        inline: true
                      }
                    ],
                    color: 0x1F80D7,
                  }
                ]
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
