import 'dotenv/config';
import { DiscordRequest } from './utils.js';

const channelId = process.env.BUTTON_CHANNEL_ID;

const res = await DiscordRequest(`channels/${channelId}/messages`, {
  method: 'POST',
  body: {
    embeds: [
      {
        title: '🎶 Create an Event',
        description:
          'Click the button below to schedule a new service and its rehearsal.\n\n' +
          '**You\'ll be asked for:**\n' +
          '• Event title, band members, location, date, and time\n' +
          '• Rehearsal date, location, and time\n\n',
        color: 0xa07df2,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: 'Create Event',
            emoji: { name: '➕' },
            custom_id: 'open_create_event_modal',
          },
        ],
      },
    ],
  },
});

const message = await res.json();
console.log('Posted button message:', message.id);