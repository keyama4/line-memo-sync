import { App, Plugin, PluginSettingTab, Setting, Notice, normalizePath, Modal, TFile, ToggleComponent } from 'obsidian';
import { requestUrl } from 'obsidian';
import { API_ENDPOINTS, LINE_ADD_FRIEND_URL, PLUGIN_DISPLAY_NAME, setApiBaseUrl } from './constants';
import { countByCategory, type CategoryCounts } from './classify';
import { KeyManager } from './crypto/keyManager';
import { MessageEncryptor } from './crypto/messageEncryptor';
import { E2EEErrorHandler } from './crypto/errorHandler';
import { getDateString, getDateWithHyphens, getISOString, getDateTimeForFileName, getTimeOnly, getTimeString } from './dateUtils';

interface LinePluginSettings {
  noteFolderPath: string;
  vaultId: string;
  lineUserId: string;
  autoSync: boolean;
  syncInterval: number;
  syncOnStartup: boolean;
  organizeByDate: boolean;
  fileNameTemplate: string;
  e2eeEnabled: boolean;
  groupMessagesByDate: boolean;
  groupedMessageTemplate: string;
  groupedFrontmatterTemplate: string;
  groupedFileNameTemplate: string;
  apiUrl?: string;
  shareStats: boolean;
  pairingCode?: string;
}

const UNREADABLE_PLACEHOLDER = '[メッセージを読み込めませんでした]';

const DEFAULT_SETTINGS: LinePluginSettings = {
  noteFolderPath: 'LINE',
  vaultId: '',
  lineUserId: '',
  autoSync: true,
  syncInterval: 2,
  syncOnStartup: true,
  organizeByDate: false,
  fileNameTemplate: '{date}-{messageId}',
  e2eeEnabled: true,
  groupMessagesByDate: false,
  groupedMessageTemplate: '{time}: {text}',
  groupedFrontmatterTemplate: 'source: LINE\ndate: {date}',
  groupedFileNameTemplate: '{date}',
  shareStats: false,
}

interface LineMessage {
  timestamp: number;
  messageId: string;
  userId: string;
  text: string;
  vaultId: string;
  synced?: boolean;
  encrypted?: boolean;
  encryptedContent?: string;
  encryptedAESKey?: string;
  iv?: string;
  senderKeyId?: string;
  recipientUserId?: string;
  version?: string;
}

// Helper function for template parsing
function parseMessageTemplate(template: string, message: LineMessage, messageText: string, getJSTTimeString: (timestamp: number) => string): string {
  return template
    .replace(/{time}/g, getJSTTimeString(message.timestamp))
    .replace(/{text}/g, messageText)
    .replace(/{messageId}/g, message.messageId)
    .replace(/{userId}/g, message.userId);
}

// Helper function for frontmatter template parsing
function parseFrontmatterTemplate(template: string, dateString: string): string {
  return template
    .replace(/{date}/g, dateString.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))
    .replace(/{datecompact}/g, dateString);
}

export default class LinePlugin extends Plugin {
  settings: LinePluginSettings;
  syncIntervalId: number | null = null;
  keyManager: KeyManager;
  messageEncryptor: MessageEncryptor;
  errorHandler: E2EEErrorHandler;

  async onload() {
    await this.loadSettings();

    this.keyManager = new KeyManager(this);
    this.messageEncryptor = new MessageEncryptor(this.keyManager);
    this.errorHandler = new E2EEErrorHandler(this.keyManager, this.messageEncryptor);

    if (this.settings.lineUserId && this.settings.vaultId) {
      try {
        await this.keyManager.initialize();
      } catch {
        // Sync falls back to unreadable-message placeholders if E2EE cannot initialize.
      }
    }

    this.addSettingTab(new LineSettingTab(this.app, this));

    this.addCommand({
      id: 'sync-line-messages',
      name: 'LINE のメモを取り込む',
      callback: async () => {
        await this.syncMessages();
      },
    });

    this.addRibbonIcon('refresh-cw', 'LINE のメモを取り込む', async () => {
      await this.syncMessages();
    });

    this.setupAutoSync();

    if (this.settings.syncOnStartup) {
      this.registerInterval(
        activeWindow.setTimeout(() => {
          void this.syncMessages(true);
        }, 3000)
      );
    }
  }

  onunload() {
    this.clearAutoSync();
  }

  async loadSettings() {
    const data = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    setApiBaseUrl(this.settings.apiUrl);
  }

  async saveSettings() {
    const currentData = await this.loadData() || {};
    const dataToSave = {
      ...currentData,
      ...this.settings
    };
    await this.saveData(dataToSave);
    setApiBaseUrl(this.settings.apiUrl);
    this.setupAutoSync();
  }

  private generateFileName(message: LineMessage): string {
    const template = this.settings.fileNameTemplate;
    const timestamp = message.timestamp;

    const variables = {
      '{date}': getDateWithHyphens(timestamp),
      '{datecompact}': getDateString(timestamp),
      '{time}': getTimeOnly(timestamp),
      '{datetime}': getDateTimeForFileName(timestamp),
      '{messageId}': message.messageId,
      '{userId}': message.userId,
      '{timestamp}': timestamp.toString()
    };

    let fileName = template;
    for (const [variable, value] of Object.entries(variables)) {
      fileName = fileName.replace(new RegExp(variable.replace(/[{}]/g, '\\$&'), 'g'), value);
    }

    if (!fileName.endsWith('.md')) {
      fileName += '.md';
    }

    return fileName;
  }

  private async generateUniqueFileName(message: LineMessage, folderPath: string): Promise<string> {
    const baseFileName = this.generateFileName(message);
    const baseName = baseFileName.replace(/\.md$/, '');
    const extension = '.md';

    let uniqueFileName = baseFileName;
    let counter = 1;

    while (true) {
      const fullPath = normalizePath(`${folderPath}/${uniqueFileName}`);
      const file = this.app.vault.getAbstractFileByPath(fullPath);
      const exists = file !== null;

      if (!exists) {
        return uniqueFileName;
      }

      uniqueFileName = `${baseName}_${counter}${extension}`;
      counter++;
    }
  }

  private setupAutoSync() {
    this.clearAutoSync();

    if (this.settings.autoSync) {
      const interval = Math.max(1, Math.min(5, this.settings.syncInterval));

      const intervalMs = interval * 60 * 60 * 1000;

      this.syncIntervalId = window.setInterval(() => {
        void this.syncMessages(true);
      }, intervalMs);
    }
  }

  private clearAutoSync() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  private parseMessageTemplate(template: string, message: LineMessage, messageText: string): string {
    return parseMessageTemplate(template, message, messageText, getTimeString);
  }

  private async syncMessages(isAutoSync = false) {
    if (!this.settings.vaultId) {
      new Notice('Vault ID が未設定です。設定画面で入力してください。');
      return;
    }

    const keys = await this.keyManager.loadKeys();

    if (!keys && this.settings.lineUserId) {
      try {
        await this.keyManager.initialize();
      } catch {
        // Continue syncing; encrypted messages will use the standard unreadable placeholder.
      }
    }

    try {
      if (!isAutoSync) {
        new Notice('LINE のメモを取り込んでいます...');
      }

      const url = API_ENDPOINTS.MESSAGES(this.settings.vaultId, this.settings.lineUserId);

      const response = await requestUrl({
        url: url,
        method: 'GET',
      });

      if (response.status !== 200) {
        throw new Error(`Failed to fetch messages: ${response.status}`);
      }

      const responseText = response.text;

      let messages: LineMessage[];
      try {
        messages = JSON.parse(responseText) as LineMessage[];
      } catch {
        throw new Error('Invalid response format');
      }

      let newMessageCount = 0;
      const syncedMessageIds: string[] = [];
      const syncedTexts: { date: string; text: string }[] = [];

      if (this.settings.groupMessagesByDate) {
        // Group messages by date
        const messagesByDate = new Map<string, LineMessage[]>();
        
        for (const message of messages) {
          if (message.synced) {
            continue;
          }
          const dateString = getDateString(message.timestamp);
          if (!messagesByDate.has(dateString)) {
            messagesByDate.set(dateString, []);
          }
          messagesByDate.get(dateString)!.push(message);
        }

        // Process grouped messages
        for (const [dateString, dateMessages] of messagesByDate) {
          let folderPath: string;
          if (this.settings.organizeByDate) {
            folderPath = `${this.settings.noteFolderPath}/${dateString}`;
          } else {
            folderPath = this.settings.noteFolderPath;
          }

          try {
            // Create folders if needed
            const normalizedFolderPath = normalizePath(this.settings.noteFolderPath);
            const folder = this.app.vault.getAbstractFileByPath(normalizedFolderPath);
            if (!folder) {
              await this.app.vault.createFolder(normalizedFolderPath);
            }

            const normalizedTargetFolderPath = normalizePath(folderPath);
            const targetFolder = this.app.vault.getAbstractFileByPath(normalizedTargetFolderPath);
            if (!targetFolder) {
              await this.app.vault.createFolder(normalizedTargetFolderPath);
            }

            // Generate file name for date-based file
            const fileNameWithoutExt = parseFrontmatterTemplate(this.settings.groupedFileNameTemplate, dateString);
            const fileName = `${fileNameWithoutExt}.md`;
            const filePath = `${folderPath}/${fileName}`;
            const normalizedFilePath = normalizePath(filePath);

            // Check if file already exists
            let existingContent = '';
            const existingFile = this.app.vault.getAbstractFileByPath(normalizedFilePath);
            if (existingFile instanceof TFile) {
              existingContent = await this.app.vault.read(existingFile);
            }

            // Process all messages for this date
            const newMessages: string[] = [];
            for (const message of dateMessages) {
              let messageText: string;
              try {
                messageText = await this.messageEncryptor.processMessage(message);
              } catch (error) {
                try {
                  const handled = await this.errorHandler.handleError(error as Error, `message_${message.messageId}`);
                  messageText = handled ?? (message.text || UNREADABLE_PLACEHOLDER);
                } catch {
                  messageText = message.text || UNREADABLE_PLACEHOLDER;
                }
              }

              const messageContent = this.parseMessageTemplate(
                this.settings.groupedMessageTemplate,
                message,
                messageText
              );

              newMessages.push(messageContent);
              if (messageText !== UNREADABLE_PLACEHOLDER) {
                syncedTexts.push({ date: getDateWithHyphens(message.timestamp), text: messageText });
              }
              syncedMessageIds.push(message.messageId);
              newMessageCount++;
            }

            // Append new messages to existing content or create new file
            let finalContent: string;
            if (existingContent) {
              finalContent = existingContent.trimEnd() + '\n' + newMessages.join('\n');
            } else {
              // Create new file with frontmatter
              const parsedFrontmatter = parseFrontmatterTemplate(this.settings.groupedFrontmatterTemplate, dateString);
              const frontmatter = [
                `---`,
                parsedFrontmatter,
                `---`,
                ``,
                ''
              ].join('\n');
              finalContent = frontmatter + newMessages.join('\n');
            }

            const fileToWrite = this.app.vault.getAbstractFileByPath(normalizedFilePath);
            if (fileToWrite instanceof TFile) {
              await this.app.vault.modify(fileToWrite, finalContent);
            } else {
              await this.app.vault.create(normalizedFilePath, finalContent);
            }
          } catch {
            // Skip the date group that failed and continue with the remaining messages.
          }
        }
      } else {
        // Original logic: one file per message
        for (const message of messages) {
          if (message.synced) {
            continue;
          }

          let folderPath: string;
          if (this.settings.organizeByDate) {
            const dateString = getDateString(message.timestamp);
            folderPath = `${this.settings.noteFolderPath}/${dateString}`;
          } else {
            folderPath = this.settings.noteFolderPath;
          }

          try {
            const fileName = await this.generateUniqueFileName(message, folderPath);
            const filePath = `${folderPath}/${fileName}`;
            const normalizedFilePath = normalizePath(filePath);

            const normalizedFolderPath = normalizePath(this.settings.noteFolderPath);
            const baseFolder = this.app.vault.getAbstractFileByPath(normalizedFolderPath);
            if (!baseFolder) {
              await this.app.vault.createFolder(normalizedFolderPath);
            }

            const normalizedTargetFolderPath = normalizePath(folderPath);
            const targetFolder = this.app.vault.getAbstractFileByPath(normalizedTargetFolderPath);
            if (!targetFolder) {
              await this.app.vault.createFolder(normalizedTargetFolderPath);
            }

            let messageText: string;
            try {
              messageText = await this.messageEncryptor.processMessage(message);
            } catch (error) {
              try {
                const handled = await this.errorHandler.handleError(error as Error, `message_${message.messageId}`);
                messageText = handled ?? (message.text || UNREADABLE_PLACEHOLDER);
              } catch {
                messageText = message.text || UNREADABLE_PLACEHOLDER;
              }
            }

            const content = [
              `---`,
              `source: LINE`,
              `date: ${getISOString(message.timestamp)}`,
              `messageId: ${message.messageId}`,
              `---`,
              ``,
              `${messageText}`
            ].join('\n');

            await this.app.vault.create(normalizedFilePath, content);
            if (messageText !== UNREADABLE_PLACEHOLDER) {
              syncedTexts.push({ date: getDateWithHyphens(message.timestamp), text: messageText });
            }
            newMessageCount++;
            syncedMessageIds.push(message.messageId);
          } catch {
            // Skip the failed message and continue syncing subsequent messages.
          }
        }
      }

      let acknowledged = false;
      if (syncedMessageIds.length > 0) {
        acknowledged = await this.updateSyncStatus(syncedMessageIds);
      }

      if (acknowledged && this.settings.shareStats && syncedTexts.length > 0) {
        await this.sendStats(syncedTexts);
      }

      if (newMessageCount > 0 || !isAutoSync) {
        const summary = newMessageCount > 0 ? `${newMessageCount}件のメモを取り込みました` : '新しいメモはありません';
        new Notice(`LINE Memo Sync: ${summary}`);
      }
    } catch (err) {
      new Notice(`LINE のメモを取り込めませんでした: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  private async updateSyncStatus(messageIds: string[]): Promise<boolean> {
    try {
      if (!this.settings.lineUserId) {
        return false;
      }

      const response = await requestUrl({
        url: API_ENDPOINTS.UPDATE_SYNC_STATUS,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          vaultId: this.settings.vaultId,
          messageIds: messageIds,
          userId: this.settings.lineUserId,
        }),
      });

      return response.status === 200;
    } catch {
      return false;
    }
  }

  // 本人がオンにした場合だけ、日付ごとの種類別件数を送る。本文は送らない
  private async sendStats(entries: { date: string; text: string }[]) {
    if (!this.settings.lineUserId || !this.settings.vaultId) {
      return;
    }
    const byDate = new Map<string, string[]>();
    for (const entry of entries) {
      if (!byDate.has(entry.date)) {
        byDate.set(entry.date, []);
      }
      byDate.get(entry.date)!.push(entry.text);
    }
    for (const [date, texts] of byDate) {
      const counts: CategoryCounts = countByCategory(texts);
      try {
        await requestUrl({
          url: API_ENDPOINTS.STATS,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: this.settings.lineUserId,
            vaultId: this.settings.vaultId,
            date,
            counts,
          }),
        });
      } catch {
        // 集計はおまけなので、失敗しても同期は成功扱いにする
      }
    }
  }

  async sendStatsOptOut() {
    if (!this.settings.lineUserId || !this.settings.vaultId) {
      return;
    }
    try {
      await requestUrl({
        url: API_ENDPOINTS.STATS_OPT_OUT,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: this.settings.lineUserId, vaultId: this.settings.vaultId }),
      });
    } catch {
      // 次にオンにしたときの送信で上書きされるので、失敗は握りつぶす
    }
  }

  private async registerCurrentPublicKey(): Promise<void> {
    try {
      await this.keyManager.initialize();
    } catch (error) {
      const keys = await this.keyManager.loadKeys();
      if (!keys) {
        throw error;
      }

      // Existing keys are enough to refresh the Worker-side public key.
    }

    await this.keyManager.forceRegisterPublicKey();
  }

  async registerMapping() {
    const code = (this.settings.pairingCode ?? '').trim();
    let vaultId = this.settings.vaultId.trim();

    if (!/^\d{6}$/.test(code)) {
      new Notice('LINE から届いた6桁の連携コードを入力してください。');
      return;
    }
    if (!vaultId) {
      // 合言葉は認証に使うので、空なら推測されにくい値を作る
      vaultId = crypto.randomUUID();
    }
    this.settings.vaultId = vaultId;
    await this.saveSettings();

    try {
      const response = await requestUrl({
        url: API_ENDPOINTS.MAPPING,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code, vaultId }),
        throw: false,
      });

      if (response.status === 404) {
        throw new Error('連携コードが期限切れか間違っています。LINE で「連携コード」と送って新しいコードをもらってください');
      }
      if (response.status !== 200) {
        throw new Error(`サーバーが ${response.status} を返しました`);
      }

      const userId = (response.json as { userId?: string } | undefined)?.userId;
      if (!userId) {
        throw new Error('サーバーの応答に LINE User ID がありません');
      }
      this.settings.lineUserId = userId;
      this.settings.pairingCode = '';
      await this.saveSettings();

      try {
        await this.registerCurrentPublicKey();
      } catch (keyError) {
        new Notice(`連携はできましたが、暗号化の鍵を登録できませんでした。もう一度 Register を押してください: ${keyError instanceof Error ? keyError.message : 'Unknown error'}`);
        return;
      }

      new Notice('連携できました。LINE にメモを送ってみてください。');
    } catch (error) {
      new Notice(`連携に失敗しました: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async resetMapping() {
    if (!this.settings.lineUserId || !this.settings.vaultId) {
      new Notice('まだ連携されていません。');
      return;
    }

    try {
      const response = await requestUrl({
        url: API_ENDPOINTS.DELETE_MAPPING,
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: this.settings.lineUserId,
          vaultId: this.settings.vaultId,
        }),
      });

      if (response.status !== 200) {
        throw new Error(`サーバーが ${response.status} を返しました`);
      }

      // Clear local settings
      this.settings.lineUserId = '';
      await this.saveSettings();

      new Notice('連携を解除しました。サーバーに残っていた未同期のメモも消えています。');
    } catch (error) {
      new Notice(`解除に失敗しました: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

class ConfirmResetModal extends Modal {
  private onConfirm: () => void;

  constructor(app: App, onConfirm: () => void) {
    super(app);
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '連携を解除しますか？' });
    contentEl.createEl('p', { text: 'サーバー側の登録と、まだ取り込んでいないメモが消えます。もう一度使うには、LINE で新しい連携コードをもらって Register し直します。' });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    buttonContainer.createEl('button', { text: 'キャンセル' })
      .addEventListener('click', () => {
        this.close();
      });

    const confirmBtn = buttonContainer.createEl('button', {
      text: '解除する',
      cls: 'mod-warning'
    });
    confirmBtn.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class LineSettingTab extends PluginSettingTab {
  plugin: LinePlugin;

  constructor(app: App, plugin: LinePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Don't use top-level headings in settings tab

    const intro = containerEl.createDiv({ cls: 'line-memo-sync-intro' });
    intro.createEl('p', { text: `${PLUGIN_DISPLAY_NAME}: LINE に送ったメモが、この Vault に貯まります。` });
    const steps = intro.createEl('ol');
    steps.createEl('li', { text: '公式 LINE を友だち追加して「連携コード」と送る' });
    steps.createEl('li', { text: '届いた6桁を下の「連携コード」に入れる' });
    steps.createEl('li', { text: '「Register」を押す（Vault ID は空なら自動で作られます）' });
    if (LINE_ADD_FRIEND_URL) {
      const p = intro.createEl('p');
      p.createEl('a', { text: '公式 LINE を友だち追加する', href: LINE_ADD_FRIEND_URL });
    }

    new Setting(containerEl)
      .setName('Note folder path')
      .setDesc('LINEメッセージが保存されるフォルダパス')
      .addText(text => text
        .setPlaceholder('LINE')
        .setValue(this.plugin.settings.noteFolderPath)
        .onChange(async (value) => {
          this.plugin.settings.noteFolderPath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Vault ID')
      .setDesc('この Vault だけがメモを取り出せるようにする合言葉。パスワードと同じ扱いで、他人に見せないでください。空のまま Register すると自動で作られます')
      .addText(text => text
        .setPlaceholder('Enter vault ID')
        .setValue(this.plugin.settings.vaultId)
        .onChange(async (value) => {
          this.plugin.settings.vaultId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('連携コード')
      .setDesc('LINE で「連携コード」と送ると届く6桁の数字。10分で期限が切れます')
      .addText(text => text
        .setPlaceholder('123456')
        .setValue(this.plugin.settings.pairingCode ?? '')
        .onChange((value) => {
          this.plugin.settings.pairingCode = value.trim();
        }));

    new Setting(containerEl)
      .setName('連携状態')
      .setDesc(this.plugin.settings.lineUserId ? '連携済み。LINE に送ったメモがこの Vault に届きます' : '未連携。連携コードを入れて Register を押してください');

    new Setting(containerEl)
      .setName('Auto sync')
      .setDesc('LINEメッセージを自動的に同期するかどうか')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();

          syncIntervalSetting.settingEl.toggle(value);
        }));

    const syncIntervalSetting = new Setting(containerEl)
      .setName('Sync interval')
      .setDesc('LINEメッセージを同期する間隔（時間単位）')
      .addDropdown(dropdown => {
        const hours = [1, 2, 3, 4, 5];
        hours.forEach(hour => {
          dropdown.addOption(hour.toString(), `${hour}時間`);
        });

        dropdown.setValue(this.plugin.settings.syncInterval.toString())
        dropdown.onChange(async (value) => {
          const interval = parseInt(value);
          if (!isNaN(interval) && interval >= 1 && interval <= 5) {
            this.plugin.settings.syncInterval = interval;
            await this.plugin.saveSettings();
          }
        });
      });

    syncIntervalSetting.settingEl.toggle(this.plugin.settings.autoSync);

    new Setting(containerEl)
      .setName('Sync on startup')
      .setDesc('Obsidian起動時にLINEメッセージを同期するかどうか')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        }));

    let organizeBydateToggle: ToggleComponent;
    new Setting(containerEl)
      .setName('Organize by date')
      .setDesc('日付ごとにフォルダを作成してメッセージを整理するかどうか（注意：「Group messages by date」をオンにすると自動的にオフになりますが、手動で再度オンにすることができます）')
      .addToggle(toggle => {
        organizeBydateToggle = toggle;
        toggle.setValue(this.plugin.settings.organizeByDate)
          .onChange(async (value) => {
            this.plugin.settings.organizeByDate = value;
            await this.plugin.saveSettings();
          });
      });

    // Add section header for file organization
    new Setting(containerEl)
      .setHeading()
      .setName('ファイル整理設定');

    new Setting(containerEl)
      .setName('Group messages by date')
      .setDesc('同じ日付のメッセージを1つのファイルにまとめるかどうか（チェックを外すとメッセージごとに個別のファイルを作成）')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.groupMessagesByDate)
        .onChange(async (value) => {
          this.plugin.settings.groupMessagesByDate = value;
          
          // When enabling group by date, disable organize by date by default
          if (value && this.plugin.settings.organizeByDate) {
            this.plugin.settings.organizeByDate = false;
            // Update the toggle UI
            if (organizeBydateToggle) {
              organizeBydateToggle.setValue(false);
            }
          }
          
          await this.plugin.saveSettings();
          
          // Show/hide the grouped message related settings
          messageTemplateSetting.settingEl.toggle(value);
          frontmatterTemplateSetting.settingEl.toggle(value);
          groupedFileNameSetting.settingEl.toggle(value);
        }));

    const messageTemplateSetting = new Setting(containerEl)
      .setName('Grouped message template')
      .setDesc('日付でグループ化されたメッセージの表示テンプレート\n利用可能な変数: {time} - 時刻, {text} - メッセージ内容, {messageId} - メッセージID, {userId} - ユーザーID')
      .addTextArea(text => {
        text.setPlaceholder('{time}: {text}')
          .setValue(this.plugin.settings.groupedMessageTemplate)
          .onChange(async (value) => {
            this.plugin.settings.groupedMessageTemplate = value || '{time}: {text}';
            await this.plugin.saveSettings();
          });
        
        // Make text area large
        text.inputEl.rows = 3;
        
        return text;
      });
    

    // Initially hide the message template setting if grouping is disabled
    messageTemplateSetting.settingEl.toggle(this.plugin.settings.groupMessagesByDate);

    const frontmatterTemplateSetting = new Setting(containerEl)
      .setName('Grouped message frontmatter template')
      .setDesc('日付でグループ化されたファイルのフロントマター\n利用可能な変数: {date} - 日付, {datecompact} - 日付（ハイフンなし）')
      .addTextArea(text => {
        text.setPlaceholder('source: LINE\ndate: {date}')
          .setValue(this.plugin.settings.groupedFrontmatterTemplate)
          .onChange(async (value) => {
            this.plugin.settings.groupedFrontmatterTemplate = value || 'source: LINE\ndate: {date}';
            await this.plugin.saveSettings();
          });
        
        text.inputEl.rows = 5;
        
        return text;
      });
    
    // Initially hide the frontmatter template setting if grouping is disabled
    frontmatterTemplateSetting.settingEl.toggle(this.plugin.settings.groupMessagesByDate);

    const groupedFileNameSetting = new Setting(containerEl)
      .setName('Grouped file name template')
      .setDesc('日付ごとにまとめられたファイルの名前（「Group messages by date」がオンの場合に使用）\n利用可能な変数: {date} - 日付 (例: 2024-01-15), {datecompact} - 日付ハイフンなし (例: 20240115)')
      .addText(text => text
        .setPlaceholder('{date}')
        .setValue(this.plugin.settings.groupedFileNameTemplate)
        .onChange(async (value) => {
          this.plugin.settings.groupedFileNameTemplate = value || '{date}';
          await this.plugin.saveSettings();
        }));
    
    // Initially hide the grouped file name setting if grouping is disabled
    groupedFileNameSetting.settingEl.toggle(this.plugin.settings.groupMessagesByDate);

    // Add an info box to explain the difference
    const infoBox = containerEl.createDiv({ cls: 'setting-item-description line-plugin-info-box' });
    infoBox.createEl('strong', { text: 'ファイル名の使い分け：' });
    infoBox.createEl('br');
    infoBox.createSpan({ text: '• ' });
    infoBox.createEl('strong', { text: 'Group messages by date がオン：' });
    infoBox.createSpan({ text: ' 1日分のメッセージが1つのファイルにまとめられ、「Grouped file name template」が使用されます' });
    infoBox.createEl('br');
    infoBox.createSpan({ text: '  ※ 固定のファイル名（例：{date}を使わずに「LINE-Messages」など）を設定すると、すべてのメッセージが常に同じファイルに追記されます' });
    infoBox.createEl('br');
    infoBox.createSpan({ text: '• ' });
    infoBox.createEl('strong', { text: 'Group messages by date がオフ：' });
    infoBox.createSpan({ text: ' 各メッセージが個別のファイルとして保存され、「Individual message file name template」が使用されます' });

    new Setting(containerEl)
      .setName('Individual message file name template')
      .setDesc('個別メッセージファイルのファイル名テンプレート（「Group messages by date」がオフの場合に使用）\n利用可能な変数: {date}, {datecompact}, {time}, {datetime}, {messageId}, {userId}, {timestamp}')
      .addText(text => text
        .setPlaceholder('{date}-{messageId}')
        .setValue(this.plugin.settings.fileNameTemplate)
        .onChange(async (value) => {
          this.plugin.settings.fileNameTemplate = value || '{date}-{messageId}';
          await this.plugin.saveSettings();
        }));

    containerEl.createDiv({
      text: '変数の説明:',
      cls: 'setting-item-description'
    });
    containerEl.createEl('ul', {}, (ul) => {
      ul.createEl('li', { text: '{date}: 日付 (例: 2024-01-15)' });
      ul.createEl('li', { text: '{datecompact}: 日付（ハイフンなし） (例: 20240115)' });
      ul.createEl('li', { text: '{time}: 時刻 (例: 103045)' });
      ul.createEl('li', { text: '{datetime}: 日時 (例: 20240115103045)' });
      ul.createEl('li', { text: '{messageId}: メッセージID' });
      ul.createEl('li', { text: '{userId}: ユーザーID' });
      ul.createEl('li', { text: '{timestamp}: Unixタイムスタンプ' });
    });

    // Connection settings section
    new Setting(containerEl)
      .setHeading()
      .setName('接続設定');

    new Setting(containerEl)
      .setName('Register')
      .setDesc('連携コードでこの Vault と LINE を結び、この Vault だけが読める暗号化の鍵を作ります。「設定が途中です」と LINE に言われたときも、このボタンで直せます')
      .addButton(button => button
        .setButtonText('Register')
        .onClick(async () => {
          await this.plugin.registerMapping();
        }));

    new Setting(containerEl)
      .setName('利用状況の共有（種類別の件数だけ）')
      .setDesc('オンにすると、取り込んだメモを「タスク／アイデア／リンク／メモ」に分けた件数だけを、日付ごとに送ります。メモの本文は送りません。この数字は、みんながどんなメモを貯めているかを知り、次の発信テーマを決める参考にします')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.shareStats)
        .onChange(async (value) => {
          this.plugin.settings.shareStats = value;
          await this.plugin.saveSettings();
          if (!value) {
            await this.plugin.sendStatsOptOut();
          }
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('詳細設定');

    new Setting(containerEl)
      .setName('API URL')
      .setDesc('自分で受付サーバーを立てる人向け。空欄なら公式のサーバーを使います')
      .addText(text => text
        .setPlaceholder('https://line-memo-sync.example.workers.dev')
        .setValue(this.plugin.settings.apiUrl ?? '')
        .onChange(async (value) => {
          this.plugin.settings.apiUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Reset')
      .setDesc('サーバー側の登録を消します。別の Vault に付け替えたいときに使います')
      .addButton(button => button
        .setButtonText('Reset')
        .setWarning()
        .onClick(() => {
          new ConfirmResetModal(this.app, () => {
            void this.plugin.resetMapping();
          }).open();
        }));
  }
}
