import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VeniceBalancePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        // --- Account ---
        const accountGroup = new Adw.PreferencesGroup({
            title: 'Account',
            description: 'Create an API key at https://venice.ai/settings/api. ' +
                'The extension calls <base>/api_keys/rate_limits for the balance and ' +
                '<base>/billing/usage-history for today\'s usage.',
        });
        page.add(accountGroup);

        const urlRow = new Adw.EntryRow({title: 'API address (base URL)'});
        urlRow.text = settings.get_string('api-base-url');
        urlRow.connect('changed', () => settings.set_string('api-base-url', urlRow.text.trim()));
        accountGroup.add(urlRow);

        const resetBtn = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Reset to default Venice endpoint',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resetBtn.connect('clicked', () => {
            settings.reset('api-base-url');
            urlRow.text = settings.get_string('api-base-url');
        });
        urlRow.add_suffix(resetBtn);

        const keyRow = new Adw.PasswordEntryRow({title: 'API key'});
        keyRow.text = settings.get_string('api-key');
        keyRow.connect('changed', () => settings.set_string('api-key', keyRow.text.trim()));
        accountGroup.add(keyRow);

        // --- Display ---
        const displayGroup = new Adw.PreferencesGroup({title: 'Display'});
        page.add(displayGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between balance checks',
            adjustment: new Gtk.Adjustment({lower: 30, upper: 86400, step_increment: 30, page_increment: 300}),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(intervalRow);

        const decimalsRow = new Adw.SpinRow({
            title: 'Decimal places',
            subtitle: 'Precision of the amount shown in the panel',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 4, step_increment: 1}),
        });
        settings.bind('decimals', decimalsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(decimalsRow);

        const diemRow = new Adw.SwitchRow({
            title: 'Show DIEM balance',
            subtitle: 'Also show staked DIEM credits next to USD in the panel',
        });
        settings.bind('show-diem', diemRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(diemRow);
    }
}
