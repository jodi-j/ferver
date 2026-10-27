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

const pendingEventDrafts = new Map();

const EASTERN_TZ = 'America/New_York';

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour, +parts.minute, +parts.second
  );
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

// Takes "YYYY-MM-DD" and a 12-hour time like "6:30 PM" (or "6:30pm", "6 PM")
// as Eastern time (EST/EDT handled automatically). Returns a Date, or null if invalid.
function parseEasternDateTime(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr ?? '').trim());
  const tm = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/.exec((timeStr ?? '').trim());
  if (!dm || !tm) return null;

  const [, y, mo, d] = dm.map(Number);
  let h = Number(tm[1]);
  const mi = Number(tm[2] ?? 0);
  const meridiem = tm[3].toLowerCase();
  if (h < 1 || h > 12 || mi > 59) return null;

  if (meridiem === 'p' && h !== 12) h += 12;
  if (meridiem === 'a' && h === 12) h = 0;

  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(utcGuess);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // e.g. Feb 31

  let ts = utcGuess - getTimeZoneOffsetMs(new Date(utcGuess), EASTERN_TZ);
  ts = utcGuess - getTimeZoneOffsetMs(new Date(ts), EASTERN_TZ); // re-check near DST changes
  return new Date(ts);
}

function formatEasternDate(date) {
  return date.toLocaleDateString('en-US', {
    timeZone: EASTERN_TZ,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }); // "January 1, 2026"
}

function formatEasternTime(date) {
  return date.toLocaleTimeString('en-US', {
    timeZone: EASTERN_TZ,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }); // "6:30 PM EST"
}

function textInputLabel(label, customId, placeholder, description) {
  return {
    type: 18,
    label,
    ...(description && { description }),
    component: {
      type: MessageComponentTypes.INPUT_TEXT,
      custom_id: customId,
      style: 1,
      placeholder,
      required: true,
    },
  };
}

function getCreateEventModal() {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: 'create_event_modal',
      title: 'Create an Event',
      components: [
        textInputLabel('Event title', 'event_title', 'Christian Love - January 1, 2026', 'Title should include event name and date'),
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
        textInputLabel('Location', 'event_location', 'Location'),
        textInputLabel('Date (YYYY-MM-DD)', 'event_date', 'YYYY-MM-DD'),
        textInputLabel('Time (Eastern, e.g. 6:30 PM)', 'event_time', '6:30 PM'),
      ],
    },
  };
}

function getCreateRehearsalModal() {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: 'create_rehearsal_modal',
      title: 'Add Rehearsal Details',
      components: [
        textInputLabel('Rehearsal Date (YYYY-MM-DD)', 'rehearsal_date', 'YYYY-MM-DD'),
        textInputLabel('Rehearsal Location', 'rehearsal_location', 'Location'),
        textInputLabel('Rehearsal Time (Eastern, e.g. 6:30 PM)', 'rehearsal_time', '6:30 PM'),
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
      const { type, data, guild_id: guildId, member, user, token, application_id: applicationId } = body;
      const userId = member?.user?.id ?? user?.id;

      const editOriginal = (content) =>
        DiscordRequest(`webhooks/${applicationId}/${token}/messages/@original`, {
          method: 'PATCH',
          body: { content },
        });

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

      if (type === InteractionType.MESSAGE_COMPONENT) {
        if (data.custom_id === 'open_rehearsal_modal') {
          return res.send(getCreateRehearsalModal());
        }
      }

      if (type === InteractionType.MODAL_SUBMIT) {
        const modalId = data.custom_id;

        if (modalId === 'create_event_modal') {
          const values = collectModalValues(data.components);
          const startTime = parseEasternDateTime(values.event_date, values.event_time);

          if (!startTime) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: 64,
                content: 'Invalid event date/time. Use YYYY-MM-DD for the date and a time like 6:30 PM (Eastern).',
              },
            });
          }

          if (startTime <= new Date()) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                flags: 64,
                content: `❌ Event time must be in the future. You submitted: ${formatEasternDate(startTime)} at ${formatEasternTime(startTime)}`,
              },
            });
          }

          const draftKey = `${guildId ?? 'dm'}:${member?.user?.id ?? user?.id ?? 'unknown'}`;
          pendingEventDrafts.set(draftKey, {
            ...values,
            event_band_resolved: data.resolved || {},
          });

          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              flags: 64,
              content: 'Event details saved! Now add the rehearsal details:',
              components: [
                {
                  type: MessageComponentTypes.ACTION_ROW,
                  components: [
                    {
                      type: MessageComponentTypes.BUTTON,
                      style: 1,
                      label: 'Add rehearsal details',
                      custom_id: 'open_rehearsal_modal',
                    },
                  ],
                },
              ],
            },
          });
        }

        if (modalId === 'create_rehearsal_modal') {
          const values = collectModalValues(data.components);
          const draftKey = `${guildId ?? 'dm'}:${userId ?? 'unknown'}`;
          const draft = pendingEventDrafts.get(draftKey);

          if (!draft) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { flags: 64, content: 'Your event draft expired. Please start the event flow again.' },
            });
          }

          const fullValues = { ...draft, ...values };
          const eventStartTime = parseEasternDateTime(fullValues.event_date, fullValues.event_time);
          const rehearsalStartTime = parseEasternDateTime(fullValues.rehearsal_date, fullValues.rehearsal_time);
          const mentionText = formatMentionableValues(fullValues.event_band, draft.event_band_resolved || {});

          if (!eventStartTime || !rehearsalStartTime) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { flags: 64, content: 'Invalid date/time. Use YYYY-MM-DD for the date and a time like 6:30 PM (Eastern).' },
            });
          }

          if (eventStartTime <= new Date()) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { flags: 64, content: '❌ Event time must be in the future.' },
            });
          }

          if (rehearsalStartTime <= new Date()) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { flags: 64, content: '❌ Rehearsal time must be in the future.' },
            });
          }

          if (!guildId) {
            return res.send({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { flags: 64, content: 'Events can only be created inside a server.' },
            });
          }

          res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

          try {
            const eventRes = await DiscordRequest(`guilds/${guildId}/scheduled-events`, {
              method: 'POST',
              body: {
                name: fullValues.event_title,
                scheduled_start_time: eventStartTime.toISOString(),
                scheduled_end_time: new Date(eventStartTime.getTime() + 60 * 60 * 1000).toISOString(),
                privacy_level: 2,
                entity_type: 3,
                entity_metadata: { location: fullValues.event_location },
              },
            });
            const eventData = await eventRes.json();
            const eventUrl = `https://discord.com/events/${guildId}/${eventData.id}`;

            const rehearsalRes = await DiscordRequest(`guilds/${guildId}/scheduled-events`, {
              method: 'POST',
              body: {
                name: `${fullValues.event_title} Rehearsal`,
                scheduled_start_time: rehearsalStartTime.toISOString(),
                scheduled_end_time: new Date(rehearsalStartTime.getTime() + 60 * 60 * 1000).toISOString(),
                privacy_level: 2,
                entity_type: 3,
                entity_metadata: { location: fullValues.rehearsal_location },
              },
            });
            const rehearsalData = await rehearsalRes.json();
            const rehearsalUrl = `https://discord.com/events/${guildId}/${rehearsalData.id}`;

            const eventsChannelId = process.env.EVENTS_CHANNEL_ID;
            if (eventsChannelId) {
              const discussionContent = [
                `Band: ${mentionText}`,
                `Location: ${fullValues.event_location}`,
                `Call Time: ${formatEasternDate(eventStartTime)} at ${formatEasternTime(eventStartTime)}`,
                '',
                `Rehearsal Date: ${formatEasternDate(rehearsalStartTime)}`,
                `Rehearsal Location: ${fullValues.rehearsal_location}`,
                `Rehearsal Time: ${formatEasternTime(rehearsalStartTime)}`,
                '',
                `Service[Link](${eventUrl}) | Rehearsal[Link](${rehearsalUrl})`,
              ].join('\n');

              try {
                await DiscordRequest(`channels/${eventsChannelId}/threads`, {
                  method: 'POST',
                  body: {
                    name: fullValues.event_title,
                    auto_archive_duration: 10080,
                    message: { content: discussionContent },
                  },
                });
              } catch (forumErr) {
                console.error('Failed to create forum post:', forumErr);
              }
            }

            pendingEventDrafts.delete(draftKey);

            await editOriginal(
              `✅ Event created!\n• **${eventData.name}**\n• Event link: ${eventUrl}\n• Rehearsal: ${rehearsalData.name}\n• Rehearsal link: ${rehearsalUrl}`
            );
          } catch (err) {
            console.error(err);
            try {
              await editOriginal(`Failed to create event: ${err.message}`);
            } catch (patchErr) {
              console.error('Failed to send error followup:', patchErr);
            }
          }
          return;
        }
      }

      return res.status(400).json({ error: 'unknown interaction type' });
    } catch (err) {
      console.error('interaction error', err);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'internal error' });
      }
    }
  }
);

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
