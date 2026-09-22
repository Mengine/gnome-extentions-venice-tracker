# Venice Tracker – GNOME Shell extension

Shows your remaining [Venice.ai](https://venice.ai) credits in the GNOME top panel,
with today's usage in the dropdown.

```
Activities   Sep 22  17:54        …   [V $12.34]  🔊 📶 🔋
```

Clicking the indicator opens:

```
Balance
  USD: $12.3400
  DIEM: 0.0000
  Bundled credits: $0.0000
  Tier: paid (access OK)
Today
  Spent: $0.4312
  Requests: 37
  Tokens: 184.2k (151.0k in / 33.2k out)
  Top model: zai-org-glm-5-1 (0.3120)
Last update: 18:02:11
Refresh now
Open Venice dashboard
Settings…
```

## Requirements

- GNOME Shell 47 – 50
- libsoup 3, libadwaita (standard on any recent GNOME desktop)
- A Venice API key (https://venice.ai/settings/api)

## Install

```bash
git clone https://github.com/Mengine/gnome-extentions-venice-tracker.git
cd gnome-extentions-venice-tracker
glib-compile-schemas schemas/
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/venice-balance@mengine
```

Log out and back in (Wayland can't hot-reload extensions), then:

```bash
gnome-extensions enable venice-balance@mengine
gnome-extensions prefs venice-balance@mengine   # paste your API key
```

## Settings

| Setting | Default | Notes |
|---|---|---|
| API address (base URL) | `https://api.venice.ai/api/v1` | `/api_keys/rate_limits` and `/billing/usage-history` are appended |
| API key | — | Stored in dconf (plain text, user-readable) |
| Refresh interval | 300 s | 30 s – 24 h |
| Decimal places | 2 | Panel label precision |
| Show DIEM balance | off | Also show staked DIEM credits in the panel |

## How it works

- Balance: `GET /api_keys/rate_limits` → `data.balances.{USD,DIEM,BUNDLED_CREDITS}`
- Today's usage: `GET /billing/usage-history?startTimestamp=<local midnight, UTC>`
  paginated via `nextCursor`, summed per currency. Ledger charges are negative,
  so absolute values are summed.

The Venice Billing API is marked **beta** by Venice; the response shape may change.

## Debugging

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep venice-balance
```

## License

MIT
