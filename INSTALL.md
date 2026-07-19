# Installing Arete Widget

This guide is for anyone who just wants to **install and run the app** — no
technical background needed. Pick your computer type below and follow the
steps.

All downloads live on the
**[latest release page](https://github.com/project-arete/arete-widget/releases/latest)**.
The links below point at the current version (v0.1.1); if a newer version
exists, grab the matching file from that page instead.

> ### ⚠️ Before you start: expect a security warning
> These installers are **not signed** with an Apple or Microsoft developer
> certificate yet. That means your computer will show a warning the first time
> you open the app — something like *"cannot verify the developer"* or
> *"Windows protected your PC"*. **This is expected.** Each section below
> shows the extra click needed to proceed. Only ever download the app from
> this project's own releases page.

---

## macOS

**1. Find out which Mac you have.** Click the Apple menu () → **About This
Mac**. If "Chip" says *Apple M1/M2/M3/M4…* you have **Apple Silicon**; if it
says *Intel*, you have an **Intel Mac**.

**2. Download the right file:**

- Apple Silicon: [Arete-Widget-0.1.1-arm64.dmg](https://github.com/project-arete/arete-widget/releases/download/v0.1.1/Arete-Widget-0.1.1-arm64.dmg)
- Intel: [Arete-Widget-0.1.1-x64.dmg](https://github.com/project-arete/arete-widget/releases/download/v0.1.1/Arete-Widget-0.1.1-x64.dmg)

**3. Install.** Open the downloaded `.dmg` and drag **Arete Widget** onto the
**Applications** folder shown next to it.

**4. First launch (the unsigned-app step).** Don't double-click the first
time. Instead, open your **Applications** folder, **right-click (or
Control-click) Arete Widget → Open**, then click **Open** in the dialog.

> On newer versions of macOS the dialog may only offer "Done". If so: open
> **System Settings → Privacy & Security**, scroll down to the message about
> Arete Widget, and click **Open Anyway**. You only have to do this once —
> afterwards it opens like any other app.

---

## Windows

**1. Download the installer:**
[Arete-Widget-Setup-0.1.1.exe](https://github.com/project-arete/arete-widget/releases/download/v0.1.1/Arete-Widget-Setup-0.1.1.exe)

**2. Run it.** Windows will likely show a blue **"Windows protected your
PC"** SmartScreen box (that's the unsigned-app warning). Click **More info**,
then **Run anyway**.

**3. Done.** The app installs itself and creates a Start-menu shortcut named
**Arete Widget**.

---

## Linux

**AppImage (works on most distributions):**

1. Download: [Arete-Widget-0.1.1-x86_64.AppImage](https://github.com/project-arete/arete-widget/releases/download/v0.1.1/Arete-Widget-0.1.1-x86_64.AppImage)
2. Make it runnable: right-click the file → **Properties → Permissions →
   allow executing as a program** (or in a terminal: `chmod +x Arete-Widget-*.AppImage`).
3. Double-click it to run. No installation needed — the file *is* the app.

---

## After installing

Open the app, go to the **Config** tab, and enter the realm address and
credentials your realm administrator gave you — then click **Connect**. You
can tick *Remember password* and *Connect automatically on launch* so it's
zero-click from then on. Then head to the **Widgets** tab and add your first
virtual widget.

**Updating:** just download and install a newer version from the
[releases page](https://github.com/project-arete/arete-widget/releases/latest)
over the old one — your settings and widgets are kept.
