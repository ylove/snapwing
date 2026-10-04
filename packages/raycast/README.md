# Snapwing for Raycast

Fix it from here. Send selected text or a screenshot to your Snapwing server. It tells you first whether the problem is already tracked, then files a ticket if it is new.

## Commands

**Fix from Selection** sends the text you have selected in any app (a stack trace, an error message, a note). Assign a global hotkey to it in Raycast.

**Send Screenshot** sends the newest image in your macOS screenshots folder (the location set in `defaults read com.apple.screencapture location`, else the Desktop). If that folder has no image, it sends the image on the clipboard.

Both commands show Snapwing's first answer as a short list:

- Already tracked: `Already tracked as WEB-830 (open, assigned to Dana). Open it?` with Open it and Not now.
- New and inferred: `New. Looks like the website (from src/cart/... in the trace). File it?`
- New, surface unknown: `New. Which surface?` with the surfaces from your workspace map.

When it is settled, a HUD shows the outcome, such as `Filed as WEB-1042` or `Already tracked as WEB-830`.

## Setup

Set two preferences (Raycast asks the first time you run a command):

| Preference | What |
|---|---|
| Endpoint | Your Snapwing server URL, for example `https://snapwing.example.com` or `http://localhost:3000`. |
| Token | Your personal capture token, which starts with `swc_`. You get it at onboarding; it identifies you alone and can be revoked alone. |

If a command says `Your Snapwing token is wrong or was revoked`, choose Open Extension Preferences and paste a new token.

## Privacy

Selected text and screenshots go only to the endpoint you configure, with your token in the `Authorization` header. Nothing is sent until you run a command. The extension stores nothing but its two preferences (the token in Raycast's encrypted preference store).

## Development

```
pnpm --filter snapwing-raycast test        # vitest with @raycast/api mocked
pnpm --filter snapwing-raycast typecheck
pnpm --filter snapwing-raycast dev         # ray develop; needs Raycast
```

`ray lint` and `ray build` need Raycast's own toolchain and are not part of the repository gate. The extension uses `@snapwing/capture-client` for the token, endpoint, sending, and the lookup-first response.

## Store submission

Not submitted yet (publishing phase). The `metadata/` folder holds the store screenshots (2000 x 1250 PNG, taken with Raycast's Window Capture) once they exist.
