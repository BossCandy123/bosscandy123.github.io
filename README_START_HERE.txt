EclipseStud Copilot Full Project v2.8.0

For development from GitHub, use the repository root as the Edge extension load folder:

  stripchat_copilot_full_extension-ver2.80/

For the packaged operator build, use a clean generated copy:

  EclipseStud_Copilot_FULL_PROJECT_v2.8.0/
This repository also includes a ready-generated release archive:

  EclipseStud_Copilot_v2.8.0_loadable.zip
Start order:

1. Double-click START_WEB_APP.cmd from the folder you loaded in Edge.
2. If it asks for an OpenAI API key, paste it once. Windows saves it encrypted for your user account.
3. Open Edge > Extensions > Manage extensions > Load unpacked.
4. Select the cloned repository root above, or the packaged operator folder above. Do not select an older sibling folder.
5. Open StripChat and pin/open EclipseStud Copilot.
6. In the extension popup, click Web app to enable the dashboard bridge.
7. Keep the dashboard open at https://127.0.0.1:8789/dashboard.

Correct extension markers:

  Name: EclipseStud Copilot OpenAI - LOAD THIS
  Version: 2.8.0
  Panel: EclipseStud Copilot OpenAI v2.8.0

What is included (AI is now the actual core of the extension):

  - Live Copilot hero as the primary in-room experience (high-reasoning "Best move right now" button + natural language Ask)
  - Proactive auto-suggestions on meaningful tips and room signals (the model barely has to initiate)
  - Ultra low-effort flow: suggestions have Copy + Use buttons; "Super Copilot" one-button mode
  - Deep memory + GPT-5.5 style extra high-reasoning prompts that anticipate what the performer needs while on camera
  - Legacy specific tools (goals, titles, etc.) are de-emphasized and hidden by default
  - Server-persisted drag-to-reorder Action queue on the dashboard (visual priority order that survives refresh)
  - Bulk send/dismiss, keyboard power (numbers copy suggestions, / focuses Ask)
  - Full web dashboard operator console for prepping/queuing lines
  - Local HTTPS service + bridge between in-room panel and dashboard

The goal: the model focuses on performing. The AI watches, reasons at high level, and gives perfect, paste/say-ready moves with almost zero extra work.

Do not load old folders named stripchat_copilot_full_extension, stripchat_copilot_full_extension_updated, ES_Copilot_AI_FIXED_LOAD_THIS, or older ES_Copilot_READY_ZIP copies.
