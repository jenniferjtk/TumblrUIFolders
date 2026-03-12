# Tumblr Folders — Chrome Extension

Save Tumblr posts into folders. Grid view inside the sidebar. Syncs via private posts + tags, so it works on mobile too.

---

## Setup: Getting Your Tumblr API Credentials

Before loading the extension, you need to register a Tumblr app to get OAuth credentials.

### Step 1 — Register your app on Tumblr

1. Go to **https://www.tumblr.com/oauth/apps**
2. Click **Register application**
3. Fill in:
   - **Application name**: Tumblr Folders (or anything you like)
   - **Application website**: `https://github.com` (can be anything)
   - **Default callback URL**: You'll need your Chrome extension ID for this (see Step 2)
   - **OAuth2 redirect URLs**: Same as above
4. Submit — you'll get a **Consumer Key** (Client ID) and **Consumer Secret**

### Step 2 — Find your Extension ID

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select this folder
4. Your extension ID will appear under the extension name (looks like: `abcdefghijklmnopqrstuvwxyz123456`)

### Step 3 — Set your Redirect URI

Go back to your Tumblr app settings and set the callback URL to:
```
https://YOUR_EXTENSION_ID.chromiumapp.org/oauth
```
Replace `YOUR_EXTENSION_ID` with the ID from Step 2.

### Step 4 — Add credentials to the extension

Open `scripts/background.js` and replace the placeholder values near the top:

```js
const CLIENT_ID = 'YOUR_TUMBLR_CLIENT_ID';      // ← paste Consumer Key here
const CLIENT_SECRET = 'YOUR_TUMBLR_CLIENT_SECRET'; // ← paste Consumer Secret here
```

### Step 5 — Reload the extension

Go back to `chrome://extensions` and click the **reload** button on Tumblr Folders.

---

## Using the Extension

1. Go to **tumblr.com** — the folder sidebar will appear on the left
2. Click **Connect Tumblr Account** and log in
3. If you have drafts, you'll see a **Migrate Drafts** prompt — click it to convert all drafts to private posts (they land in **Unsorted**)
4. **Save a post**: hover any feed post and click the 📁 save button → pick a folder
5. **Browse folders**: click any folder in the sidebar to see your saved posts in a grid
6. **Move a post**: hover a post card in the grid → click the ⤴ button → pick a new folder
7. **Create a folder**: click the + button in the sidebar header
8. **On mobile**: your saved posts are private posts tagged `tf-folder:FOLDERNAME` — browse them on your blog filtered by tag

---

## How it works

- **Saved posts** = private reblogs with a `tf-folder:foldername` tag
- **Folders** = just filtered views of your private tagged posts
- **Migration** = converts drafts → private posts tagged `tf-folder:unsorted`
- **No external server** — Tumblr is the backend, your browser is the client

---

## File Structure

```
tumblr-folders/
├── manifest.json          # Extension config
├── popup.html             # Extension icon popup
├── scripts/
│   ├── background.js      # OAuth + all Tumblr API calls
│   └── content.js         # Sidebar UI injected into tumblr.com
├── styles/
│   └── sidebar.css        # All sidebar styles
└── icons/
    └── (add your icons)   # 16x16, 48x48, 128x128 PNG
```

---

## Notes

- Tumblr's API rate limit is 250 requests per hour. The migration batches requests to stay well under this.
- The sidebar nudges Tumblr's layout to the right. If it breaks on certain pages, you may need to adjust the CSS selectors in `sidebar.css` to match Tumblr's current DOM.
- This is a **Manifest V3** extension (the current Chrome standard).
