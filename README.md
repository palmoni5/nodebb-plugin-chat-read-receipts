# nodebb-plugin-chat-read-receipts

Adds WhatsApp-style **read receipts** to NodeBB chat. Next to each of your own
outgoing messages a small indicator shows whether the other participant(s) have
read it.

## What is displayed

The indicator is only shown on **your own** messages (you never see receipts on
other people's messages — same as WhatsApp).

**One-on-one rooms** (you + one other person):
- `✓` (grey) — **Sent**, not read yet.
- `✓✓` (blue) — **Read** by the other person.

**Group rooms** (more than one other participant) — read state is per-message,
based on each participant's last-seen time:
- `✓` (grey) — nobody else has read it yet.
- `👁 Read by k/N` — read by some of the `N` other participants. Hover to see
  the list of names.
- `✓✓ Read by all` (blue) — every other participant has read it.

## How it works

- NodeBB already tracks a per-user, per-room "last read" timestamp. A message is
  considered "read" by a participant when that participant's last-seen time for
  the room is at or after the message's timestamp.
- When you open/focus a chat room, your client tells the server you've seen it
  (`plugins.chatReadReceipts.markSeen`). The server records the timestamp and
  broadcasts it to everyone currently in the room, so receipts update live.
- On load, the client fetches the per-participant read state
  (`plugins.chatReadReceipts.getRoomReadState`) and renders the indicators.

No core files are modified.

## Privacy note

Read receipts are symmetric: if you can see whether others read your messages,
they can see whether you read theirs (it is tied to focusing the room).
