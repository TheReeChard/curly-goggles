# Our Timeline

A private, in-browser tool for couples filing an I-130. It turns your photos into:

- **A filing PDF:** cover page, a dated timeline table, an exhibit index, and labeled photos two per page (Exhibit A-1, A-2…). Prints well in black and white on US Letter.
- **A keepsake PDF:** a designed photo book of your relationship.

Nothing is uploaded. Photos are processed in your browser and saved only on that device.

> This tool helps organize evidence. It is not legal advice and is not affiliated with USCIS.

## How it works

1. **Add photos** with Google sign-in (Google's photo picker, up to 2,000 per pick), or with downloaded files, an unzipped Google Takeout folder, or a .zip.
2. **Photos are grouped into events by date.** Each photo gets a score for sharpness, lighting and faces in the frame (two faces scores highest). Near-duplicates and burst shots are reduced to the best one.
3. **You name each event,** add the place and a short description, and add events that have no photos (how you met, the wedding, the lease, a joint account).
4. **Check for gaps:** the tool flags missing evidence of living together or shared finances, long gaps, and dates that don't add up.
5. **Download** the filing PDF and the keepsake PDF.

### ✨ AI mode (optional)

Paste an Anthropic API key (from <https://console.anthropic.com/>) and the tool does the curating and writing for you:

- For each event, Claude looks at a shortlist of up to 20 photos (small copies) and ranks the best ones: both of you in frame, clear faces, good poses, variety, no repeats or screenshots.
- It drafts the event title, type and description, a caption for each chosen photo, and the intro page of the keepsake.
- It can run automatically right after you add photos, or per event with "✨ Choose & write with AI".
- AI-written text is highlighted and flagged under "Check for gaps" until you edit or confirm it. It is told never to invent names, places or dates, but **you must review everything before filing.**

Privacy: the shortlisted photo copies are sent to Anthropic only when AI mode runs. Your key stays in this browser, and is saved only if you tick "Remember". Cost is billed to your Anthropic account, roughly $1–3 for 1,000 photos.

You can pin any photo ("Always include") or leave it out. Use "Save project file" to back up your work or move it to another device.

## Hosting (GitHub Pages)

1. Repository **Settings → General → Danger zone → Change visibility → Public** (Pages is free for public repos).
2. **Settings → Pages:** Source "Deploy from a branch", pick this branch and `/ (root)`, then Save.
3. After about a minute the site is live at `https://<your-username>.github.io/curly-goggles/`.

The code is public. Your photos and timeline never leave your browser.

## Google setup (one time, about 10 minutes)

1. Go to <https://console.cloud.google.com/> and create a project, for example "Our Timeline".
2. **APIs & Services → Library:** search for **Google Photos Picker API** and click Enable.
3. **APIs & Services → OAuth consent screen** (also called "Google Auth Platform"):
   - User type: **External**. App name: anything. Add your email as the support and developer contact.
   - Scopes: add `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`.
   - **Audience / Test users:** add both of your Gmail addresses. Leave the app in **Testing**, so Google doesn't need to review it. (In Testing mode, sign-ins may need to be repeated about every 7 days.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:**
   - Type: **Web application**
   - Authorized JavaScript origins: `https://<your-username>.github.io` (and `http://localhost:8000` if you also run it locally)
5. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) into `js/config.js`:

   ```js
   export const CONFIG = { googleClientId: '1234-abc.apps.googleusercontent.com' };
   ```

The Client ID isn't a secret; it only identifies the app to Google.

## Running locally (optional)

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Notes

- iPhone HEIC files can't be opened by most browsers when added as files. Google sign-in avoids this, because Google returns those photos as JPG.
- For 1,000+ photos, use a laptop or desktop. Phones can run out of memory while making a large keepsake PDF.
- Face detection uses Google's MediaPipe model, which runs inside your browser. If it can't load, photos are ranked on sharpness and lighting only.
