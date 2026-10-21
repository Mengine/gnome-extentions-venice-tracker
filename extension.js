import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BALANCE_PATH = '/api_keys/rate_limits';
const USAGE_PATH = '/billing/usage-history';
const USAGE_MAX_PAGES = 10; // 10 x 1000 entries per day is plenty

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const VeniceIndicator = GObject.registerClass(
class VeniceIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Venice Balance', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._session = new Soup.Session({timeout: 20});
        this._timeoutId = null;
        this._cancellable = null;

        // Panel widget: compact text-only label
        this.add_style_class_name('venice-balance-button');
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'venice-balance-label',
        });
        this.add_child(this._label);

        // --- Popup menu: balance section
        this._addHeader('Balance');
        this._usdItem = this._addInfo('USD: —');
        this._diemItem = this._addInfo('DIEM: —');
        this._bundledItem = this._addInfo('Bundled credits: —');
        this._tierItem = this._addInfo('Tier: —');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // --- Popup menu: today's usage section
        this._addHeader('Today');
        this._todaySpentItem = this._addInfo('Spent: —');
        this._todayRequestsItem = this._addInfo('Requests: —');
        this._todayTokensItem = this._addInfo('Tokens: —');
        this._todayTopItem = this._addInfo('Top model: —');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._updatedItem = this._addInfo('Last update: never');
        this._updatedItem.label.add_style_class_name('dim-label');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        const openItem = new PopupMenu.PopupMenuItem('Open Venice dashboard');
        openItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://venice.ai/settings/api', null);
        });
        this.menu.addMenuItem(openItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Settings…');
        prefsItem.connect('activate', () => extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        // React to setting changes
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'api-key' || key === 'api-base-url' || key === 'refresh-interval')
                this._restartTimer();
            else
                this._refresh();
        });

        this._restartTimer();
    }

    // ----- menu helpers -----

    _addHeader(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        item.label.add_style_class_name('venice-balance-header');
        this.menu.addMenuItem(item);
        return item;
    }

    _addInfo(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        this.menu.addMenuItem(item);
        return item;
    }

    // ----- timer -----

    _restartTimer() {
        this._stopTimer();
        this._refresh();
        const interval = this._settings.get_int('refresh-interval');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    // ----- HTTP -----

    _baseUrl() {
        return this._settings.get_string('api-base-url').trim().replace(/\/+$/, '');
    }

    /**
     * GET `url` with the configured bearer token; resolves with parsed JSON.
     * Rejects with HttpError on non-2xx, or Gio.IOErrorEnum.CANCELLED if cancelled.
     */
    _getJson(url, apiKey, cancellable) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('GET', url);
            if (!msg) {
                reject(new Error(`Could not parse URL: ${url}`));
                return;
            }
            msg.request_headers.append('Authorization', `Bearer ${apiKey}`);
            msg.request_headers.append('Accept', 'application/json');

            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const status = msg.get_status();
                    const body = new TextDecoder().decode(bytes.get_data());

                    if (status < 200 || status >= 300) {
                        let err = `HTTP ${status}`;
                        try {
                            err = JSON.parse(body).error ?? err;
                        } catch {}
                        reject(new HttpError(status, err));
                        return;
                    }
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Walk /billing/usage-history from local midnight until now and aggregate.
     * Returns {spent: {USD, DIEM, BUNDLED_CREDITS}, requests, promptTokens,
     *          completionTokens, bySku: Map<sku, amountUsd>}.
     */
    async _fetchTodayUsage(base, apiKey, cancellable) {
        // Local midnight -> UTC ISO string (endpoint requires "Z" suffix)
        const now = GLib.DateTime.new_now_local();
        const midnight = GLib.DateTime.new_local(
            now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0);
        const startIso = midnight.to_utc().format('%Y-%m-%dT%H:%M:%S.000Z');

        const agg = {
            spent: {USD: 0, DIEM: 0, BUNDLED_CREDITS: 0},
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            bySku: new Map(),
        };

        let url = `${base}${USAGE_PATH}?startTimestamp=${encodeURIComponent(startIso)}&pageSize=1000`;
        for (let page = 0; page < USAGE_MAX_PAGES; page++) {
            const json = await this._getJson(url, apiKey, cancellable);
            const rows = json.data ?? [];

            for (const row of rows) {
                const amt = Math.abs(Number(row.amount ?? 0)); // charges are negative
                const cur = row.currency ?? 'USD';
                if (cur in agg.spent)
                    agg.spent[cur] += amt;
                agg.requests += 1;
                const d = row.inferenceDetails;
                if (d) {
                    agg.promptTokens += d.promptTokens ?? 0;
                    agg.completionTokens += d.completionTokens ?? 0;
                }
                const sku = row.sku ?? 'unknown';
                agg.bySku.set(sku, (agg.bySku.get(sku) ?? 0) + amt);
            }

            if (!json.nextCursor)
                break;
            url = `${base}${USAGE_PATH}?cursor=${encodeURIComponent(json.nextCursor)}`;
        }
        return agg;
    }

    // ----- refresh -----

    _setError(text, detail) {
        this._label.text = text;
        this._label.add_style_class_name('venice-balance-error');
        if (detail)
            this._updatedItem.label.text = detail;
    }

    _isCancelled(e) {
        return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
    }

    async _refresh() {
        const apiKey = this._settings.get_string('api-key').trim();
        if (!apiKey) {
            this._setError('No key', 'Set your API key in Settings');
            return;
        }
        const base = this._baseUrl();
        if (!base.startsWith('http://') && !base.startsWith('https://')) {
            this._setError('Bad URL', 'API address must start with http:// or https://');
            return;
        }

        // Cancel any in-flight request
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        // 1. Balance
        try {
            const json = await this._getJson(`${base}${BALANCE_PATH}`, apiKey, cancellable);
            this._updateBalance(json.data);
        } catch (e) {
            if (this._isCancelled(e))
                return;
            console.error(`[venice-balance] balance: ${e.message}`);
            this._setError(e.status === 401 ? 'Bad key' : 'Error', `Error: ${e.message}`);
            return;
        }

        // 2. Today's usage (failure here is non-fatal for the panel label)
        try {
            const usage = await this._fetchTodayUsage(base, apiKey, cancellable);
            this._updateUsage(usage);
        } catch (e) {
            if (this._isCancelled(e))
                return;
            console.error(`[venice-balance] usage: ${e.message}`);
            this._todaySpentItem.label.text = `Spent: unavailable (${e.message})`;
            this._todayRequestsItem.label.text = 'Requests: —';
            this._todayTokensItem.label.text = 'Tokens: —';
            this._todayTopItem.label.text = 'Top model: —';
        }

        if (this._cancellable === cancellable)
            this._cancellable = null;
    }

    _updateBalance(data) {
        const decimals = this._settings.get_int('decimals');
        const showDiem = this._settings.get_boolean('show-diem');
        const b = data.balances ?? {};
        const usd = Number(b.USD ?? 0);
        const diem = Number(b.DIEM ?? 0);
        const bundled = Number(b.BUNDLED_CREDITS ?? 0);

        let label = `$${usd.toFixed(decimals)}`;
        if (showDiem && diem > 0)
            label += ` | ${diem.toFixed(decimals)} DIEM`;

        this._label.text = label;
        this._label.remove_style_class_name('venice-balance-error');

        this._usdItem.label.text = `USD: $${usd.toFixed(4)}`;
        this._diemItem.label.text = `DIEM: ${diem.toFixed(4)}`;
        this._bundledItem.label.text = `Bundled credits: $${bundled.toFixed(4)}`;

        const tier = data.apiTier?.id ?? '—';
        const access = data.accessPermitted ? 'access OK' : 'ACCESS DENIED';
        this._tierItem.label.text = `Tier: ${tier} (${access})`;

        const now = GLib.DateTime.new_now_local().format('%H:%M:%S');
        this._updatedItem.label.text = `Last update: ${now}`;
    }

    _updateUsage(u) {
        const parts = [];
        if (u.spent.USD > 0)
            parts.push(`$${u.spent.USD.toFixed(4)}`);
        if (u.spent.DIEM > 0)
            parts.push(`${u.spent.DIEM.toFixed(4)} DIEM`);
        if (u.spent.BUNDLED_CREDITS > 0)
            parts.push(`$${u.spent.BUNDLED_CREDITS.toFixed(4)} bundled`);
        this._todaySpentItem.label.text = `Spent: ${parts.length ? parts.join(' + ') : '$0.00'}`;

        this._todayRequestsItem.label.text = `Requests: ${u.requests}`;

        const total = u.promptTokens + u.completionTokens;
        this._todayTokensItem.label.text =
            `Tokens: ${this._fmtTokens(total)} (${this._fmtTokens(u.promptTokens)} in / ${this._fmtTokens(u.completionTokens)} out)`;

        let top = null;
        for (const [sku, amt] of u.bySku) {
            if (!top || amt > top[1])
                top = [sku, amt];
        }
        this._todayTopItem.label.text = top
            ? `Top model: ${this._shortSku(top[0])} (${top[1].toFixed(4)})`
            : 'Top model: —';
    }

    _fmtTokens(n) {
        if (n >= 1_000_000)
            return `${(n / 1_000_000).toFixed(2)}M`;
        if (n >= 1_000)
            return `${(n / 1_000).toFixed(1)}k`;
        return `${n}`;
    }

    /** Strip unit suffixes like "-llm-output-mtoken" / "-image-unit" from a SKU. */
    _shortSku(sku) {
        return sku.replace(/-(llm-(input|output)-mtoken|image-unit|.*-unit)$/, '');
    }

    destroy() {
        this._stopTimer();
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._session.abort();
        this._session = null;
        this._settings = null;
        super.destroy();
    }
});

export default class VeniceBalanceExtension extends Extension {
    enable() {
        this._indicator = new VeniceIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
