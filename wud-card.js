// Translations
const TRANSLATIONS = {
  en: {
    title: 'Docker Container Updates',
    wud_connected: 'WUD connected',
    wud_disconnected: 'WUD not reachable',
    check_updates: 'Check for Updates',
    updates_available: 'update(s) available',
    up_to_date: 'up-to-date',
    skipped: 'skipped',
    update_available_section: 'Updates Available',
    current_section: 'Up-to-Date',
    skipped_section: 'Skipped Updates',
    update: 'Update',
    updating: 'Updating...',
    no_trigger: 'No Trigger',
    release_notes: 'Release Notes',
    checking_updates: 'Checking containers for updates...',
    check_started: 'Container check started',
    check_failed: 'Check failed',
    update_started: 'Starting update for',
    update_triggered: 'Update triggered for',
    update_failed: 'Update failed',
    container_not_found: 'Container not found',
    trigger_not_found: 'Trigger not found',
    no_containers: 'No containers found',
    skip: 'Skip',
    unskip: 'Unskip'
  },
  de: {
    title: 'Docker Container Updates',
    wud_connected: 'WUD verbunden',
    wud_disconnected: 'WUD nicht erreichbar',
    check_updates: 'Überprüfen',
    updates_available: 'Update(s) verfügbar',
    up_to_date: 'aktuell',
    skipped: 'übersprungen',
    update_available_section: 'Updates verfügbar',
    current_section: 'Aktuell',
    skipped_section: 'Übersprungene Updates',
    update: 'Update',
    updating: 'Läuft...',
    no_trigger: 'Kein Trigger',
    release_notes: 'Release Notes',
    checking_updates: 'Überprüfe Container auf Updates...',
    check_started: 'Container-Überprüfung gestartet',
    check_failed: 'Überprüfung fehlgeschlagen',
    update_started: 'Starte Update für',
    update_triggered: 'Update ausgelöst für',
    update_failed: 'Update fehlgeschlagen',
    container_not_found: 'Container nicht gefunden',
    trigger_not_found: 'Trigger nicht gefunden',
    no_containers: 'Keine Container gefunden',
    skip: 'Überspringen',
    unskip: 'Wiederherstellen'
  }
};

class WudCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.wudContainers = new Map();
    this.containerTriggers = new Map();
    this.lastWudLoad = 0;
    this.currentCollapsed = true;
    this.skippedCollapsed = true;
    this.lastRenderData = null;
    this.updatingContainers = new Set();
    this._language = 'en';
    this.wudReachable = false;
    this.skippedUpdates = new Set(this._loadSkipped());
  }

  _loadSkipped() {
    try {
      const data = localStorage.getItem('wud-card-skipped');
      return data ? JSON.parse(data) : [];
    } catch { return []; }
  }

  _saveSkipped() {
    try {
      localStorage.setItem('wud-card-skipped', JSON.stringify([...this.skippedUpdates]));
    } catch {}
  }

  setConfig(config) {
    if (!config) {
      throw new Error('Invalid configuration');
    }

    // Spread raw config first so explicit defaults below take precedence
    this.config = {
      ...config,
      title: config.title || null,
      entity_filter: config.entity_filter || ['whats_up_docker', 'wud_container'],
      show_current: config.show_current !== false,
      show_available_updates: config.show_available_updates !== false,
      current_collapsed: config.current_collapsed !== false,
      enable_skip: config.enable_skip === true,
      wud_api: config.wud_api ? {
        url: config.wud_api.url,
        auth: config.wud_api.auth || null,
        user: config.wud_api.user || null,
        password: config.wud_api.password || null,
        show_update_buttons: config.wud_api.show_update_buttons !== false,
        trigger_filter: config.wud_api.trigger_filter || 'all'
      } : null,
      release_notes: config.release_notes || {},
      custom_icons: config.custom_icons || {},
      update_interval: config.update_interval || 30000,
      prefixes: config.prefixes || ['local'],
    };

    this.currentCollapsed = this.config.current_collapsed;
  }

  connectedCallback() {
    this.shadowRoot.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;

      const btn = e.target.closest('[data-action]');
      if (!btn) return;

      e.stopPropagation();
      e.preventDefault();

      const { action, entityId, triggerId, index } = btn.dataset;

      if (action === 'check-updates') this.checkForUpdates();
      else if (action === 'update') this.triggerUpdate(entityId, triggerId);
      else if (action === 'skip') this.skipUpdate(entityId);
      else if (action === 'unskip') this.unskipUpdate(entityId);
      else if (action === 'toggle-menu') this.toggleMenu(index);
      else if (action === 'show-more') this.showMoreInfo(entityId);
      else if (action === 'toggle-current') {
        this.currentCollapsed = !this.currentCollapsed;
        this.render();
      } else if (action === 'toggle-skipped') {
        this.skippedCollapsed = !this.skippedCollapsed;
        this.render();
      }
    });

    this._onDocClick = (e) => {
      if (!this.shadowRoot.contains(e.target)) {
        this.closeAllMenus();
      }
    };
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    if (this._onDocClick) {
      document.removeEventListener('click', this._onDocClick);
    }
  }

  skipUpdate(entityId) {
    this.skippedUpdates.add(entityId);
    this._saveSkipped();
    this.render();
  }

  unskipUpdate(entityId) {
    this.skippedUpdates.delete(entityId);
    this._saveSkipped();
    this.render();
  }

  set hass(hass) {
    this._hass = hass;

    if (hass.language) {
      this._language = hass.language.toLowerCase().startsWith('de') ? 'de' : 'en';
    }

    const now = Date.now();

    if (!this.lastWudLoad || (now - this.lastWudLoad) > this.config.update_interval) {
      this.lastWudLoad = now;
      this.loadWudData().then(() => this.render());
    } else if (this.hasRelevantChanges(hass)) {
      this.render();
    }
  }

  t(key) {
    const translations = TRANSLATIONS[this._language] || TRANSLATIONS.en;
    return translations[key] || key;
  }

  hasRelevantChanges(hass) {
    const currentData = this.getCurrentEntitiesData(hass);
    const currentHash = JSON.stringify(currentData);

    if (this.lastRenderData !== currentHash) {
      this.lastRenderData = currentHash;
      return true;
    }
    return false;
  }

  getCurrentEntitiesData(hass) {
    return Object.keys(hass.states)
      .filter(id => id.startsWith('update.') && this.matchesFilter(id))
      .map(id => ({
        id,
        state: hass.states[id].state,
        installed_version: hass.states[id].attributes?.installed_version,
        latest_version: hass.states[id].attributes?.latest_version
      }));
  }

  getReleaseNotesLink(name, entityObj) {
    const map = this.config.release_notes || {};
    const lname = (name || '').toLowerCase();

    let tpl = map[lname] || map[name];

    if (!tpl) {
      const keys = Object.keys(map);
      const candidates = keys
        .filter(k => {
          const lk = k.toLowerCase();
          return lname.includes(lk) || lk.includes(lname);
        })
        .sort((a, b) => b.length - a.length);
      if (candidates.length) tpl = map[candidates[0]];
    }

    if (!tpl) return null;
    return this._formatReleaseNotesUrl(tpl, entityObj, name);
  }

  _formatReleaseNotesUrl(tpl, entityObj, name) {
    const attrs = entityObj?.state?.attributes || {};
    const installed = attrs.installed_version || '';
    const latest = attrs.latest_version || '';
    const version = latest || installed || '';
    const values = { installed, latest, version, name: name || '' };

    return tpl.replace(/\{(installed|latest|version|name)\}/gi, (_, p1) => {
      const key = p1.toLowerCase();
      return encodeURIComponent(values[key] ?? '');
    });
  }

  async loadWudData() {
    if (!this.config.wud_api?.url || !this.config.wud_api?.show_update_buttons) return;

    try {
      const containersResponse = await this.fetchApi('/api/containers');
      const containers = Array.isArray(containersResponse) ? containersResponse : containersResponse.data;
      this.wudReachable = true;
      this.wudContainers.clear();
      containers.forEach(c => this.wudContainers.set(c.id, c));

      await Promise.all(containers.map(async (c) => {
        try {
          const triggersResponse = await this.fetchApi(`/api/containers/${encodeURIComponent(c.id)}/triggers`);
          const triggers = Array.isArray(triggersResponse) ? triggersResponse : triggersResponse.data;
          this.containerTriggers.set(c.id, triggers);
        } catch (e) {
          console.warn(`Failed to load triggers for ${c.id}:`, e);
        }
      }));
    } catch (e) {
      this.wudReachable = false;
      console.warn('WUD API not reachable:', e);
    }
  }

  _getAuthHeaders() {
    if (this.config.wud_api.auth) {
      return { 'Authorization': `Bearer ${this.config.wud_api.auth}` };
    }

    const { user, password } = this.config.wud_api;
    if (user && password) {
      return { 'Authorization': `Basic ${btoa(`${user}:${password}`)}` };
    }

    return {};
  }

  async fetchApi(path) {
    if (!this.config.wud_api?.url) {
      throw new Error('WUD API URL not configured');
    }

    const response = await fetch(`${this.config.wud_api.url}${path}`, {
      headers: this._getAuthHeaders()
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async checkForUpdates() {
    try {
      this.showNotification(this.t('checking_updates'), 'info');

      const response = await fetch(`${this.config.wud_api.url}/api/containers/watch`, {
        method: 'POST',
        headers: this._getAuthHeaders()
      });

      if (response.ok) {
        this.showNotification(this.t('check_started'), 'success');
        setTimeout(() => {
          this.lastWudLoad = 0;
          this.loadWudData().then(() => this.render());
        }, 3000);
      } else {
        const error = await response.text();
        throw new Error(`HTTP ${response.status}: ${error}`);
      }
    } catch (e) {
      console.error('Check updates error:', e);
      this.showNotification(`${this.t('check_failed')}: ${e.message}`, 'error');
    }
  }

  // Find the WUD API container that corresponds to a given HA entity.
  // Builds a set of candidate names from HA attributes and entity ID tail,
  // then does an exact normalized match against WUD container names.
  // Normalization (lowercase + strip non-alphanumeric) handles differences like
  // hyphens vs underscores, but never uses substring matching to avoid
  // "baikal" incorrectly matching "baikaltunnel".
  _findWudContainer(entityId) {
    if (!this.wudContainers.size) return null;

    const haState = this._hass?.states[entityId];
    const haFriendlyName = haState?.attributes?.friendly_name || '';
    const haDisplayName = haState?.attributes?.display_name || '';
    const entityTail = this._extractEntityTail(entityId);

    const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    const candidates = new Set(
      [haFriendlyName, haDisplayName, entityTail].map(normalize).filter(Boolean)
    );

    for (const [id, container] of this.wudContainers) {
      const wudName = normalize(container.displayName || container.name || '');
      if (wudName && candidates.has(wudName)) {
        return { id, container };
      }
    }

    return null;
  }

  // Strip well-known HA entity ID prefixes to get the bare container name portion.
  _extractEntityTail(entityId) {
    // Remove the "update." domain prefix first
    let tail = entityId.replace(/^update\./, '');

    // Remove WUD integration prefixes (HTTP and MQTT integrations use different patterns)
    tail = tail.replace(/^(whats_up_docker_container_|wud_container_)/, '');

    // Remove known host/prefix segments configured by the user
    const prefixes = this.config.prefixes || [];
    for (const p of prefixes) {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      tail = tail.replace(new RegExp(`^${escaped}_?`, 'i'), '');
    }

    return tail;
  }

  // Primary name resolution:
  //   1. friendly_name from HA entity attributes, stripping the WUD integration prefix
  //      ("Whats Up Docker" / "What's Up Docker") that HA prepends automatically
  //   2. WUD API container displayName / name
  //   3. Last resort: humanise the entity ID tail
  getContainerName(entityId) {
    const haState = this._hass?.states[entityId];

    // 1. Use HA's friendly_name, but strip the integration prefix HA adds automatically.
    //    e.g. "Whats Up Docker pihole" → "pihole", "Whats Up Docker BaikalTunnel" → "BaikalTunnel"
    const friendlyName = haState?.attributes?.friendly_name;
    if (friendlyName) {
      const stripped = friendlyName.replace(/^what'?s\s+up\s+docker\s+/i, '').trim();
      if (stripped) return stripped.charAt(0).toUpperCase() + stripped.slice(1);
    }

    // 2. Use WUD API container name if available
    const found = this._findWudContainer(entityId);
    if (found) {
      return found.container.displayName || found.container.name || entityId;
    }

    // 3. Humanise entity ID tail as last resort
    const tail = this._extractEntityTail(entityId);
    if (!tail) return entityId;

    return tail
      .replace(/_/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  getContainerIcon(name) {
    const lowerName = (name || '').toLowerCase();

    for (const [key, icon] of Object.entries(this.config.custom_icons || {})) {
      if (lowerName.includes(key.toLowerCase())) return icon;
    }

    const iconMap = {
      'mosquitto': 'mdi:message-outline',
      'traefik': 'mdi:router-network',
    };

    for (const [key, icon] of Object.entries(iconMap)) {
      if (lowerName.includes(key)) return icon;
    }

    return 'mdi:docker';
  }

  getAvailableTriggers(entityId) {
    const found = this._findWudContainer(entityId);
    if (!found || !this.containerTriggers.has(found.id)) return [];

    const triggers = this.containerTriggers.get(found.id);
    const allTriggers = triggers.map(t => ({ id: t.id, name: t.name, type: t.type }));

    const filter = this.config.wud_api?.trigger_filter;
    if (!filter || filter === 'all') return allTriggers;

    const filterTypes = Array.isArray(filter) ? filter : [filter];
    return allTriggers.filter(t =>
      filterTypes.some(ft =>
        t.type.toLowerCase() === ft.toLowerCase() ||
        t.name.toLowerCase() === ft.toLowerCase()
      )
    );
  }

  async triggerUpdate(entityId, triggerId) {
    const found = this._findWudContainer(entityId);
    if (!found) {
      this.showNotification(this.t('container_not_found'), 'error');
      return;
    }

    const { id: containerId } = found;
    const triggers = this.containerTriggers.get(containerId) || [];
    const trigger = triggers.find(t => t.id === triggerId);

    if (!trigger) {
      this.showNotification(this.t('trigger_not_found'), 'error');
      return;
    }

    this.updatingContainers.add(entityId);
    this.render();

    try {
      const name = this.getContainerName(entityId);
      this.showNotification(`${this.t('update_started')} ${name}...`, 'info');

      const response = await fetch(
        `${this.config.wud_api.url}/api/containers/${encodeURIComponent(containerId)}/triggers/${encodeURIComponent(trigger.type)}/${encodeURIComponent(trigger.name)}`,
        {
          method: 'POST',
          headers: this._getAuthHeaders()
        }
      );

      if (response.ok) {
        this.showNotification(`${this.t('update_triggered')} ${name}`, 'success');
        // Auto-unskip when update is triggered from skipped list
        if (this.skippedUpdates.has(entityId)) {
          this.skippedUpdates.delete(entityId);
          this._saveSkipped();
        }
        this.closeAllMenus();
      } else {
        const error = await response.text();
        throw new Error(`HTTP ${response.status}: ${error}`);
      }
    } catch (e) {
      console.error('Trigger error:', e);
      this.showNotification(`${this.t('update_failed')}: ${e.message}`, 'error');
    } finally {
      this.updatingContainers.delete(entityId);
      this.render();
    }
  }

  showNotification(message, type) {
    this.dispatchEvent(new CustomEvent('hass-notification', {
      detail: { message, type },
      bubbles: true,
      composed: true
    }));
  }

  showMoreInfo(entityId) {
    this.dispatchEvent(new CustomEvent('hass-more-info', {
      detail: { entityId },
      bubbles: true,
      composed: true
    }));
  }

  toggleMenu(index) {
    const menu = this.shadowRoot.getElementById(`menu-${index}`);
    if (!menu) return;

    const isVisible = menu.classList.contains('show');
    this.closeAllMenus();

    if (!isVisible) {
      menu.classList.add('show');
    }
  }

  closeAllMenus() {
    this.shadowRoot.querySelectorAll('.trigger-menu.show').forEach(m =>
      m.classList.remove('show')
    );
  }

  matchesFilter(entityId) {
    const filters = Array.isArray(this.config.entity_filter)
      ? this.config.entity_filter
      : [this.config.entity_filter];
    return filters.some(filter => entityId.includes(filter));
  }

  _renderUpdateButton(e, i) {
    if (!this.config.wud_api?.show_update_buttons) return '';

    if (e.triggers.length === 1) {
      return `
        <button class="btn ${e.isUpdating ? 'updating' : ''}"
                data-action="update"
                data-entity-id="${e.entityId}"
                data-trigger-id="${e.triggers[0].id}"
                ${e.isUpdating ? 'disabled' : ''}>
          ${e.isUpdating ? '<div class="spinner"></div>' : ''}
          ${e.isUpdating ? this.t('updating') : this.t('update')}
        </button>
      `;
    }

    if (e.triggers.length > 1) {
      return `
        <div class="dropdown">
          <button class="btn ${e.isUpdating ? 'updating' : ''}"
                  data-action="toggle-menu"
                  data-index="${i}"
                  ${e.isUpdating ? 'disabled' : ''}>
            ${e.isUpdating ? '<div class="spinner"></div>' : ''}
            ${e.isUpdating ? this.t('updating') : `${this.t('update')} ▼`}
          </button>
          <div class="trigger-menu" id="menu-${i}">
            ${e.triggers.map(t => `
              <div class="trigger-item"
                   data-action="update"
                   data-entity-id="${e.entityId}"
                   data-trigger-id="${t.id}"
                   style="${e.isUpdating ? 'pointer-events: none; opacity: 0.5;' : ''}">
                ${e.isUpdating ? '<div class="spinner"></div>' : ''}
                ${t.name} (${t.type})
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    return `<button class="btn" disabled>${this.t('no_trigger')}</button>`;
  }

  render() {
    if (!this._hass) return;

    const entities = Object.keys(this._hass.states)
      .filter(id => id.startsWith('update.') && this.matchesFilter(id))
      .map(id => ({
        entityId: id,
        state: this._hass.states[id],
        name: this.getContainerName(id),
        icon: this.getContainerIcon(this.getContainerName(id)),
        triggers: this.getAvailableTriggers(id),
        isUpdating: this.updatingContainers.has(id)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const allUpdates = entities.filter(e => e.state.state === 'on');
    const skipped = this.config.enable_skip
      ? allUpdates.filter(e => this.skippedUpdates.has(e.entityId))
      : [];
    const updates = allUpdates.filter(e => !this.skippedUpdates.has(e.entityId));
    const current = entities.filter(e => e.state.state === 'off');

    const displayTitle = this.config.title || this.t('title');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          background: var(--card-background-color, var(--ha-card-background));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow);
          padding: 16px;
          font-family: var(--mdc-typography-body1-font-family, inherit);
          max-width: 100%;
          box-sizing: border-box;
        }

        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 16px;
          font-size: 1.2em;
          font-weight: 500;
          color: var(--primary-text-color);
          flex-wrap: wrap;
          gap: 12px;
        }

        .header-content {
          flex: 1;
          min-width: 0;
        }

        .wud-status {
          font-size: 0.8em;
          color: var(--secondary-text-color);
          opacity: 0.7;
        }

        .release-notes a {
          font-size: 0.8em;
          color: var(--primary-color);
          text-decoration: none;
        }

        .release-notes a:hover {
          text-decoration: underline;
        }

        .summary {
          display: flex;
          gap: 12px;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }

        .chip {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: 16px;
          font-size: 0.9em;
          font-weight: 500;
          min-width: 0;
          flex-shrink: 1;
        }

        .chip.updates {
          background: rgba(255,152,0,0.1);
          color: var(--warning-color, #ff9800);
          border: 1px solid rgba(255,152,0,0.3);
        }

        .chip.current {
          background: rgba(76,175,80,0.1);
          color: var(--success-color, #4caf50);
          border: 1px solid rgba(76,175,80,0.3);
        }

        .chip.skipped {
          background: rgba(158,158,158,0.1);
          color: var(--secondary-text-color, #9e9e9e);
          border: 1px solid rgba(158,158,158,0.3);
        }

        .section-title {
          font-weight: 500;
          margin: 12px 0 8px;
          color: var(--primary-text-color);
          font-size: 1.1em;
          cursor: pointer;
          padding: 8px;
          border-radius: 6px;
          display: flex;
          align-items: center;
          gap: 8px;
          user-select: none;
          word-break: break-word;
        }

        .section-title:hover {
          background: var(--secondary-background-color, rgba(0,0,0,0.05));
        }

        .toggle-icon {
          transition: transform 0.2s;
          font-size: 1.2em;
          flex-shrink: 0;
        }

        .toggle-icon.collapsed {
          transform: rotate(-90deg);
        }

        .item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          border-radius: 8px;
          background: var(--secondary-background-color, rgba(0,0,0,0.05));
          margin-bottom: 8px;
          transition: background-color 0.2s;
          min-width: 0;
        }

        .item:hover {
          background: var(--divider-color, rgba(0,0,0,0.1));
        }

        .icon {
          width: 24px;
          height: 24px;
          flex-shrink: 0;
        }

        .icon.update-available {
          color: var(--warning-color, #ff9800);
        }

        .icon.up-to-date {
          color: var(--success-color, #4caf50);
        }

        .icon.skipped {
          color: var(--secondary-text-color, #9e9e9e);
        }

        .info {
          flex: 1;
          cursor: pointer;
          min-width: 0;
          overflow: hidden;
        }

        .name {
          font-weight: 500;
          color: var(--primary-text-color);
          word-break: break-word;
          overflow-wrap: break-word;
        }

        .status {
          font-size: 0.85em;
          color: var(--secondary-text-color);
        }

        .version {
          font-size: 0.8em;
          color: var(--secondary-text-color);
          font-family: monospace;
          word-break: break-all;
        }

        .actions {
          display: flex;
          gap: 6px;
          flex-shrink: 0;
          align-items: center;
        }

        .action-col {
          display: flex;
          flex-direction: column;
          gap: 4px;
          align-items: stretch;
        }

        .btn {
          background: var(--warning-color, #ff9800);
          color: white;
          border: none;
          border-radius: 6px;
          padding: 6px 12px;
          font-size: 0.8em;
          cursor: pointer;
          font-weight: 500;
          transition: background-color 0.2s;
          white-space: nowrap;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }

        .btn:hover {
          background: var(--warning-color-dark, #f57c00);
        }

        .btn:disabled {
          background: var(--disabled-color, #ccc);
          cursor: not-allowed;
        }

        .btn.updating {
          background: var(--primary-color);
          cursor: not-allowed;
        }

        .btn.btn-skip {
          background: var(--secondary-text-color, #9e9e9e);
        }

        .btn.btn-skip:hover {
          background: #757575;
        }

        .btn.btn-unskip {
          background: var(--info-color, #2196f3);
        }

        .btn.btn-unskip:hover {
          background: #1976d2;
        }

        .check-btn {
          background: var(--primary-color);
          color: white;
          border: none;
          border-radius: 6px;
          padding: 8px 16px;
          cursor: pointer;
          font-weight: 500;
          transition: background-color 0.2s;
          white-space: nowrap;
          flex-shrink: 0;
        }

        .check-btn:hover {
          background: var(--primary-color-dark);
        }

        .dropdown {
          position: relative;
          display: inline-block;
        }

        .trigger-menu {
          position: absolute;
          right: 0;
          top: 100%;
          background: var(--card-background-color);
          border: 1px solid var(--divider-color);
          border-radius: 6px;
          box-shadow: var(--ha-card-box-shadow);
          z-index: 1000;
          min-width: 120px;
          display: none;
          max-width: 200px;
        }

        .trigger-menu.show {
          display: block;
        }

        .trigger-item {
          padding: 8px 12px;
          cursor: pointer;
          font-size: 0.85em;
          border-bottom: 1px solid var(--divider-color);
          word-wrap: break-word;
          overflow-wrap: break-word;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .trigger-item:last-child {
          border-bottom: none;
        }

        .trigger-item:hover {
          background: var(--secondary-background-color);
        }

        .spinner {
          width: 16px;
          height: 16px;
          border: 2px solid rgba(255,255,255,0.3);
          border-top: 2px solid white;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        .collapsed {
          display: none;
        }

        .no-containers {
          text-align: center;
          padding: 20px;
          color: var(--secondary-text-color);
          font-style: italic;
        }

        ha-icon {
          --mdc-icon-size: 24px;
        }

        @media (max-width: 768px) {
          .header {
            flex-direction: column;
            align-items: stretch;
          }

          .summary {
            flex-direction: column;
          }

          .chip {
            justify-content: center;
          }

          .item {
            padding: 8px;
          }

          .actions {
            flex-direction: column;
            gap: 4px;
          }
        }
      </style>

      <div class="header">
        <div class="header-content">
          ${displayTitle}
          ${this.config.wud_api?.show_update_buttons ? `
            <div class="wud-status">${this.wudReachable ? `🟢 ${this.t('wud_connected')}` : `🔴 ${this.t('wud_disconnected')}`}</div>
          ` : ''}
        </div>
        ${this.config.wud_api?.show_update_buttons ? `
          <button class="check-btn" data-action="check-updates">${this.t('check_updates')}</button>
        ` : ''}
      </div>

      ${entities.length > 0 ? `
        <div class="summary">
          ${updates.length > 0 ? `
            <div class="chip updates">
              <ha-icon icon="mdi:update"></ha-icon>
              ${updates.length} ${this.t('updates_available')}
            </div>
          ` : ''}
          ${skipped.length > 0 ? `
            <div class="chip skipped">
              <ha-icon icon="mdi:skip-next"></ha-icon>
              ${skipped.length} ${this.t('skipped')}
            </div>
          ` : ''}
          ${current.length > 0 ? `
            <div class="chip current">
              <ha-icon icon="mdi:check-circle"></ha-icon>
              ${current.length} ${this.t('up_to_date')}
            </div>
          ` : ''}
        </div>

        ${this.config.show_available_updates && updates.length > 0 ? `
          <div class="section-title">📦 ${this.t('update_available_section')}</div>
          ${updates.map((e, i) => `
            <div class="item">
              <ha-icon class="icon update-available" icon="${e.icon}"></ha-icon>
              <div class="info" data-action="show-more" data-entity-id="${e.entityId}">
                <div class="name">${e.name}</div>
                <div class="status">${e.isUpdating ? this.t('updating') : this.t('update_available_section')}</div>
                ${e.state.attributes.installed_version ? `
                  <div class="version">
                    ${e.state.attributes.installed_version} → ${e.state.attributes.latest_version || 'latest'}
                  </div>
                ` : ''}
                ${(() => {
                  const link = this.getReleaseNotesLink(e.name, e);
                  return link ? `
                    <div class="release-notes">
                      <a href="${link}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">
                        📄 ${this.t('release_notes')}
                      </a>
                    </div>
                  ` : '';
                })()}
              </div>
              ${(this.config.wud_api?.show_update_buttons || this.config.enable_skip) ? `
                <div class="actions">
                  <div class="action-col">
                    ${this._renderUpdateButton(e, i)}
                    ${this.config.enable_skip ? `
                      <button class="btn btn-skip"
                              data-action="skip"
                              data-entity-id="${e.entityId}">
                        ${this.t('skip')}
                      </button>
                    ` : ''}
                  </div>
                </div>
              ` : ''}
            </div>
          `).join('')}
        ` : ''}

        ${this.config.enable_skip && skipped.length > 0 ? `
          <div class="section-title" data-action="toggle-skipped">
            <span class="toggle-icon ${this.skippedCollapsed ? 'collapsed' : ''}">▼</span>
            ⏭ ${this.t('skipped_section')} (${skipped.length})
          </div>
          <div class="${this.skippedCollapsed ? 'collapsed' : ''}">
            ${skipped.map((e, i) => `
              <div class="item">
                <ha-icon class="icon skipped" icon="${e.icon}"></ha-icon>
                <div class="info" data-action="show-more" data-entity-id="${e.entityId}">
                  <div class="name">${e.name}</div>
                  <div class="status">${e.isUpdating ? this.t('updating') : this.t('skipped_section')}</div>
                  ${e.state.attributes.installed_version ? `
                    <div class="version">
                      ${e.state.attributes.installed_version} → ${e.state.attributes.latest_version || 'latest'}
                    </div>
                  ` : ''}
                  ${(() => {
                    const link = this.getReleaseNotesLink(e.name, e);
                    return link ? `
                      <div class="release-notes">
                        <a href="${link}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">
                          📄 ${this.t('release_notes')}
                        </a>
                      </div>
                    ` : '';
                  })()}
                </div>
                <div class="actions">
                  <div class="action-col">
                    ${this._renderUpdateButton(e, 'skipped-' + i)}
                    <button class="btn btn-unskip"
                            data-action="unskip"
                            data-entity-id="${e.entityId}">
                      ${this.t('unskip')}
                    </button>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        ${this.config.show_current && current.length > 0 ? `
          <div class="section-title" data-action="toggle-current">
            <span class="toggle-icon ${this.currentCollapsed ? 'collapsed' : ''}">▼</span>
            ✅ ${this.t('current_section')} (${current.length})
          </div>
          <div class="${this.currentCollapsed ? 'collapsed' : ''}">
            ${current.map(e => `
              <div class="item">
                <ha-icon class="icon up-to-date" icon="${e.icon}"></ha-icon>
                <div class="info" data-action="show-more" data-entity-id="${e.entityId}">
                  <div class="name">${e.name}</div>
                  <div class="status">${this.t('up_to_date')}</div>
                  ${e.state.attributes.installed_version ? `
                    <div class="version">${e.state.attributes.installed_version}</div>
                  ` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      ` : `<div class="no-containers">${this.t('no_containers')}</div>`}
    `;
  }

  getCardSize() { return 3; }

  static getStubConfig() {
    return {
      title: 'What\'s up Docker Card',
      entity_filter: ['whats_up_docker', 'wud_container'],
      show_current: true,
      show_available_updates: true,
      current_collapsed: true,
      enable_skip: false,
      update_interval: 30000,
      wud_api: {
        url: 'http://your-wud-instance:3000',
        show_update_buttons: true,
        auth: null,
        trigger_filter: 'all'
      },
      release_notes: {},
      custom_icons: {}
    };
  }
}

customElements.define('wud-card', WudCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'wud-card',
  name: 'What\'s up Docker Card',
  description: 'Display and manage Docker container updates via What\'s Up Docker'
});
