// Translations
const TRANSLATIONS = {
  en: {
    title: 'Docker Container Updates',
    wud_connected: 'WUD connected',
    wud_disconnected: 'WUD not reachable',
    check_updates: 'Check for Updates',
    updates_available: 'update(s) available',
    up_to_date: 'up-to-date',
    update_available_section: 'Updates Available',
    current_section: 'Up-to-Date',
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
    no_containers: 'No containers found'
  },
  de: {
    title: 'Docker Container Updates',
    wud_connected: 'WUD verbunden',
    wud_disconnected: 'WUD nicht erreichbar',
    check_updates: 'Überprüfen',
    updates_available: 'Update(s) verfügbar',
    up_to_date: 'aktuell',
    update_available_section: 'Updates verfügbar',
    current_section: 'Aktuell',
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
    no_containers: 'Keine Container gefunden'
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
    this.lastRenderData = null;
    this.updatingContainers = new Set();
    this._language = 'en';
  }

  setConfig(config) {
    if (!config) {
      throw new Error('Invalid configuration');
    }

    this.config = {
      title: config.title || null, // null = use translated default
      entity_filter: config.entity_filter || ['whats_up_docker', 'wud_container'],
      show_current: config.show_current !== false,
      show_available_updates: config.show_available_updates !== false,
      current_collapsed: config.current_collapsed !== false,
      wud_api: config.wud_api ? {
        url: config.wud_api.url,
        auth: config.wud_api.auth || null,
        show_update_buttons: config.wud_api.show_update_buttons !== false
      } : null,
      release_notes: config.release_notes || {},
      custom_icons: config.custom_icons || {},
      update_interval: config.update_interval || 30000, // 30 seconds default
      ...config
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
      else if (action === 'toggle-menu') this.toggleMenu(index);
      else if (action === 'show-more') this.showMoreInfo(entityId);
      else if (action === 'toggle-current') {
        this.currentCollapsed = !this.currentCollapsed;
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

  set hass(hass) {
    this._hass = hass;

    // Update language from Home Assistant
    if (hass.language) {
      this._language = hass.language.toLowerCase().startsWith('de') ? 'de' : 'en';
    }

    const now = Date.now();

    // Load WUD data based on configured interval
    if (!this.lastWudLoad || (now - this.lastWudLoad) > this.config.update_interval) {
      this.lastWudLoad = now;
      this.loadWudData().then(() => this.render());
    } else {
      if (this.hasRelevantChanges(hass)) {
        this.render();
      }
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

  getReleaseNotesLink(name, entity) {
    const map = this.config.release_notes || {};
    const lname = (name || '').toLowerCase();

    // Exact match
    let tpl = map[lname] || map[name];

    // Fuzzy match fallback
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
    return this._formatReleaseNotesUrl(tpl, entity, name);
  }

  _formatReleaseNotesUrl(tpl, entity, name) {
    const installed = entity?.state?.attributes?.installed_version || '';
    const latest = entity?.state?.attributes?.latest_version || '';
    const version = latest || installed || '';
    const values = { installed, latest, version, name: name || '' };

    return tpl.replace(/\{(installed|latest|version|name)\}/gi, (_, p1) => {
      const key = p1.toLowerCase();
      return encodeURIComponent(values[key] ?? '');
    });
  }

  async loadWudData() {
    if (!this.config.wud_api || !this.config.wud_api.show_update_buttons) return;

    try {
      const containers = await this.fetchApi('/api/containers');
      this.wudContainers.clear();
      containers.forEach(c => this.wudContainers.set(c.id, c));

      await Promise.all(containers.map(async (c) => {
        try {
          const triggers = await this.fetchApi(`/api/containers/${encodeURIComponent(c.id)}/triggers`);
          this.containerTriggers.set(c.id, triggers);
        } catch (e) {
          console.warn(`Failed to load triggers for ${c.id}:`, e);
        }
      }));
    } catch (e) {
      console.warn('WUD API not reachable:', e);
    }
  }

  async fetchApi(path) {
    if (!this.config.wud_api?.url) {
      throw new Error('WUD API URL not configured');
    }

    const response = await fetch(`${this.config.wud_api.url}${path}`, {
      headers: this.config.wud_api.auth ? { 'Authorization': `Bearer ${this.config.wud_api.auth}` } : {}
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async checkForUpdates() {
    try {
      this.showNotification(this.t('checking_updates'), 'info');

      const response = await fetch(`${this.config.wud_api.url}/api/containers/watch`, {
        method: 'POST',
        headers: this.config.wud_api.auth ? { 'Authorization': `Bearer ${this.config.wud_api.auth}` } : {}
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

  getContainerIdFromEntity(entityId) {
    const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const entityClean = clean(entityId);

    for (const [id, container] of this.wudContainers) {
      const containerClean = clean(container.name);
      if (entityClean.includes(containerClean) || containerClean.includes(entityClean)) {
        return id;
      }
    }
    return null;
  }

  getContainerName(entityId) {
    const containerId = this.getContainerIdFromEntity(entityId);
    if (containerId && this.wudContainers.has(containerId)) {
      return this.wudContainers.get(containerId).name;
    }

    return entityId
      .replace(/^update\.(whats_up_docker_container_|wud_container_|)/, '')
      .replace(/^local_/, '')
      .replace(/_\d+$/, '')
      .replace(/_/g, ' ')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  getContainerIcon(name) {
    // Check custom icons first
    const lowerName = name.toLowerCase();
    for (const [key, icon] of Object.entries(this.config.custom_icons)) {
      if (lowerName.includes(key.toLowerCase())) return icon;
    }

    // Default icon mappings
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
    const containerId = this.getContainerIdFromEntity(entityId);
    if (!containerId || !this.containerTriggers.has(containerId)) {
      return [];
    }

    const triggers = this.containerTriggers.get(containerId);
    return triggers.map(t => ({ id: t.id, name: t.name, type: t.type }));
  }

  async triggerUpdate(entityId, triggerId) {
    const containerId = this.getContainerIdFromEntity(entityId);
    if (!containerId) {
      this.showNotification(this.t('container_not_found'), 'error');
      return;
    }

    const container = this.wudContainers.get(containerId);
    const triggers = this.containerTriggers.get(containerId) || [];
    const trigger = triggers.find(t => t.id === triggerId);

    if (!trigger) {
      this.showNotification(this.t('trigger_not_found'), 'error');
      return;
    }

    this.updatingContainers.add(entityId);
    this.render();

    try {
      this.showNotification(`${this.t('update_started')} ${this.getContainerName(entityId)}...`, 'info');

      const payload = {
        id: container.id,
        name: container.name,
        watcher: container.watcher || 'docker.local',
        image: container.image || { name: container.name },
        registry: container.registry || { name: 'hub.public' },
        architecture: container.architecture || 'amd64',
        os: container.os || 'linux',
        tag: container.tag || 'latest',
        updateKind: container.updateKind || {
          kind: "tag",
          semverDiff: "patch",
          localValue: container.tag || "current",
          remoteValue: "latest"
        }
      };

      const response = await fetch(
        `${this.config.wud_api.url}/api/triggers/${encodeURIComponent(trigger.type)}/${encodeURIComponent(trigger.name)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.wud_api.auth ? { 'Authorization': `Bearer ${this.config.wud_api.auth}` } : {})
          },
          body: JSON.stringify(payload)
        }
      );

      if (response.ok) {
        this.showNotification(`${this.t('update_triggered')} ${this.getContainerName(entityId)}`, 'success');
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

    const updates = entities.filter(e => e.state.state === 'on');
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
            <div class="wud-status">${this.wudContainers.size > 0 ? `🟢 ${this.t('wud_connected')}` : `🔴 ${this.t('wud_disconnected')}`}</div>
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
              ${this.config.wud_api?.show_update_buttons ? `
                <div class="actions">
                  ${e.triggers.length === 1 ? `
                    <button class="btn ${e.isUpdating ? 'updating' : ''}"
                            data-action="update"
                            data-entity-id="${e.entityId}"
                            data-trigger-id="${e.triggers[0].id}"
                            ${e.isUpdating ? 'disabled' : ''}>
                      ${e.isUpdating ? '<div class="spinner"></div>' : ''}
                      ${e.isUpdating ? this.t('updating') : this.t('update')}
                    </button>
                  ` : e.triggers.length > 1 ? `
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
                          <div class="trigger-item ${e.isUpdating ? 'disabled' : ''}"
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
                  ` : `
                    <button class="btn" disabled>${this.t('no_trigger')}</button>
                  `}
                </div>
              ` : ''}
            </div>
          `).join('')}
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
      update_interval: 30000,
      wud_api: {
        url: 'http://your-wud-instance:3000',
        show_update_buttons: true,
        auth: null
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