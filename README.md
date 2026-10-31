# PrintShare – print PDFs from your own laptop

You upload a PDF on your laptop → you get a link → the print shop opens the link in any browser and presses **Print Document**.
Your PDFs never leave your laptop. No Firebase, no Google Drive, no cloud database.

```
Shop owner's browser ──► Cloudflare (just a doorway) ──► Cloudflare Tunnel on your laptop ──► PrintShare server ──► uploads\ folder
```

Laptop on + PrintShare running + internet = links work. Anything else = links do not work. Your files stay safe in `uploads\`.

---

## 1. Install Node.js (once)
1. Open https://nodejs.org and click the **LTS** download button.
2. Run the installer, keep pressing **Next**, then **Finish**.
3. Check: press the Windows key, type `cmd`, press Enter, type `node -v`, press Enter. You should see a version number such as `v22.x.x`.

## 2. Put the project in a folder (once)
Unzip `PrintShare.zip` to **`C:\PrintShare`** (right-click → *Extract All*).
You should see `server.js`, `START.bat`, `STOP.bat`, `SETUP.bat` and the folder `public` directly inside `C:\PrintShare`.

*(If you ever need to create a file by hand: open Notepad, paste the code, choose File → Save As, set "Save as type" to All files, and type the exact file name, e.g. `server.js`.)*

## 3. One-time setup
Double-click **`SETUP.bat`**. It will:
- download the needed components (`npm install`), and
- install **Cloudflare Tunnel** (`cloudflared`) using Windows' built-in `winget`.

If Windows asks for permission, click **Yes**. When it says *Setup finished*, press any key.
(Manual alternative: open Command Prompt, run `cd C:\PrintShare`, then `npm install`, then `winget install --id Cloudflare.cloudflared`.)

## 4. Start PrintShare
Double-click **`START.bat`**. Two small minimized windows appear in the taskbar (**Server** and **Tunnel**). **Keep them open.**
Your browser opens `http://localhost:3000`.

- First time only: you are asked to **create an admin password** (8+ characters). Remember it.
- The top bar shows two lights. Wait until **Server: Running** and **Tunnel: Connected** are green (the tunnel takes 5–20 seconds).

## 5. Upload a PDF and get the link
1. Drag one or more PDFs into the dashed box (or click it). Progress bars show the upload.
2. Each document shows its size, page count, a **Preview** button and a **Copy link** button.
3. Optional: the **lock** icon sets a password for that one link. The **bin** icon deletes the PDF from your laptop.
4. Send the copied link (looks like `https://random-words.trycloudflare.com/print/AbC…`) to the print shop by WhatsApp, email, etc.

## 6. Test from another computer
Open the link on your phone **using mobile data (Wi-Fi off)** or on a friend's computer. You should see the PDF, the page count and the blue **Print Document** button. Printing from the shop's computer works the same way.

## 7. After shutting down or restarting Windows
Nothing is lost; PDFs and links stay saved. Just double-click **`START.bat`** again.
- To start automatically at login: press `Windows + R`, type `shell:startup`, press Enter, and drop a *shortcut* of `START.bat` into that folder.
- To stop sharing: double-click **`STOP.bat`**.

## 8. About the link address (important)
| Mode | What you need | Link address |
|---|---|---|
| **Quick Tunnel** (default, free, no account) | Nothing | A new random `https://….trycloudflare.com` address **every time you start**. Old links stop working after a restart – copy the fresh links from the dashboard. |
| **Named Tunnel** (stable address) | A free Cloudflare account **and a domain name you own** (about US$10/year; Cloudflare cannot give a permanent address without a domain) | The same address every time, e.g. `https://print.yourdomain.com` |

Setting up a stable address:
1. Add your domain to Cloudflare (free plan).
2. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**. Name it, choose Windows.
3. Copy the long **token** shown in the install command (the text after `--token`). Save it as a file named **`tunnel-token.txt`** inside `C:\PrintShare` (token only, one line).
4. In the tunnel's **Public hostname** tab add `print.yourdomain.com` with service **HTTP** → `127.0.0.1:3000`.
5. In PrintShare click the **sliders icon (Settings)** and enter `https://print.yourdomain.com`.
6. Run `STOP.bat`, then `START.bat`. It now uses your named tunnel automatically.

## 9. Printing quality – what to know
The page has a **Print method** menu (default *Automatic*):
- **Original PDF (sharpest)** – the browser's own PDF engine prints the untouched file: vector text, original page sizes and orientation. Used automatically on desktop Chrome, Edge and Firefox.
- **High-resolution images (compatibility)** – PDF.js draws each page at 300 DPI and prints it at its exact paper size. Used automatically on phones, tablets and Safari, and as a fallback. Mixed page sizes in one document print correctly in Chrome/Edge; Firefox may use one size for all pages.

Tell the shop owner, in the browser's print dialog: **Scale = 100% / Default**, **Margins = None/Default**, **don't tick "Fit to page"**, and choose the right paper size (A4, A3, Letter…) and printer. Then the output matches the PDF.

Honest limitations:
- Browsers cannot choose or lock the paper size or printer for the shop – the shop owner picks them in their own print dialog.
- Colours and exact margins depend on the shop's printer driver. Borderless printing needs a printer that supports it.
- Very large PDFs (hundreds of pages, big scans) take longer to load, and image mode needs a lot of memory. Prefer *Original PDF* for these.
- PDFs that need a password just to open are not supported.
- I could test the server, uploads, links, passwords and access rules here, but not a real Windows printer or Cloudflare tunnel. Please do the test in section 6 before relying on it.

## 10. Security – what is and is not protected
Done for you:
- The server listens **only on your laptop** (`127.0.0.1`). The internet reaches it only through your tunnel.
- The **dashboard and admin functions work only at `http://localhost:3000` on your laptop**; through the public link they return "Not found", and they also need your password.
- Every PDF gets a random 24-character ID (144 bits, impossible to guess) and is saved under that name. Checks: real-PDF content, a 100 MB limit (change with `set MAX_FILE_MB=200` before starting), safe file names. The `uploads` folder is never served as a folder and no file path is shown.
- Optional per-document password (stored hashed), password-guess limits, general rate limiting, and security headers.

Cannot be guaranteed:
- **Screenshots cannot be truly blocked.** The shop page hides itself whenever its window loses focus (for example when a snipping tool starts), reacts to the Print Screen key, and shows a faint watermark on screen only. A phone camera or a determined person can still capture it.
- **A shop owner who can view the PDF can always save it.** Hiding the download button, blocking right-click and Ctrl+S are only polite deterrents; anyone technical can still get the file through the browser's developer tools. Use a password and delete documents when the job is done.
- Anyone who has the link can open the document (unless you set a password), so send it only to the shop.
- Cloudflare carries the traffic (HTTPS-encrypted to the shop), but your files are not stored there.
- To reset a forgotten admin password: run `STOP.bat`, delete `data\config.json`, run `START.bat` and create a new one (re-enter the stable address if you use one; passwords on individual links keep working only if you do not delete `data\documents.json`).

## 10b. Strict access: one device only, no VPN
Every new PDF has **Strict access** switched on (shield icon on each document to change it):
- The **first browser and IP address** that opens the link claims it. Reloading in the same browser works.
- A different IP address, a different browser or device, or the same person after switching a **VPN on or off** (their IP changes) is refused with a clear message.
- Visitors using **Tor**, or sending proxy headers, are refused.
- In the dashboard the shield icon shows who claimed the link and when. If the shop owner changes computer, click **Release lock** and the next visitor claims it.

Honest limits of VPN blocking:
- A website cannot see "VPN on/off". PrintShare blocks (1) Tor, (2) proxy headers, (3) any IP range you list in `data\blocked-ranges.txt` (one IPv4 range per line, e.g. `203.0.113.0/24`, `#` for comments; restart START.bat after editing; public lists of VPN/datacenter ranges can be found online), and (4) any change of IP after the first visit. A VPN that was already on at the first visit, and whose range is not in your list, can still claim the link once.
- Two people on the same shop network share one IP, but the browser cookie still keeps the link to one browser.
- Clearing browser data or using a private window after the first visit also locks the shop out until you release the lock.

## 11. Troubleshooting
| Problem | Fix |
|---|---|
| `START.bat` says Node.js missing | Install Node.js (step 1), then run `SETUP.bat`. |
| "cloudflared not found" | Run `SETUP.bat`; if it still fails restart Windows once, then `START.bat`. |
| "Port 3000 is already in use" | Run `STOP.bat` first, then `START.bat`. |
| Tunnel stays orange / link does not open | Wait 30 s. Check internet. Close and re-run `START.bat`. Some work/school networks block tunnels. |
| Shop sees a Cloudflare "Error 1033/502" page | PrintShare or the tunnel is not running on your laptop – run `START.bat`. |
| Link worked yesterday, not today | Quick Tunnel addresses change on restart. Copy the new link from the dashboard (or set up a stable address, section 8). |
| Print preview looks wrong | Change **Print method** to *High-resolution images* (or the other way round) and try again. |
| Dashboard asks me to log in again | Sessions last 12 hours and are cleared when the server restarts. |

## Files
```
PrintShare\
  server.js      the local server (all backend code)
  package.json   list of components
  SETUP.bat      one-time installer      START.bat / STOP.bat   launch / stop everything
  public\        index.html, style.css, app.js (dashboard); print.html, print.css, print.js (shop page); favicon.svg
  uploads\       your PDFs (random names)      data\   document list, settings, tunnel log
```
