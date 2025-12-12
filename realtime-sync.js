// realtime-sync.js - Sincronização em Tempo Real com Google Drive Push Notifications

class RealtimeSync {
    constructor(driveClient, supabase, syncManager) {
        this.driveClient = driveClient;
        this.supabase = supabase;
        this.syncManager = syncManager;
        this.channelId = null;
        this.resourceId = null;
        this.expiration = null;
        this.watchInterval = null;
    }
    
    // Configurar webhook para receber notificações
    async setupPushNotifications(webhookUrl) {
        try {
            const drive = this.driveClient.drive;
            
            // Criar canal de notificação
            const response = await drive.files.watch({
                fileId: this.driveClient.rootFolderId,
                requestBody: {
                    id: `channel-${Date.now()}`,
                    type: 'web_hook',
                    address: webhookUrl,
                    expiration: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 dias
                }
            });
            
            this.channelId = response.data.id;
            this.resourceId = response.data.resourceId;
            this.expiration = response.data.expiration;
            
            console.log('✅ Push Notifications configuradas');
            console.log(`📡 Channel ID: ${this.channelId}`);
            console.log(`⏰ Expira em: ${new Date(parseInt(this.expiration))}`);
            
            // Renovar automaticamente antes de expirar
            this.scheduleRenewal();
            
            return true;
        } catch (error) {
            console.error('❌ Erro ao configurar push notifications:', error.message);
            return false;
        }
    }
    
    // Renovar canal antes de expirar
    scheduleRenewal() {
        if (this.watchInterval) {
            clearInterval(this.watchInterval);
        }
        
        // Renovar 1 dia antes de expirar
        const renewTime = parseInt(this.expiration) - Date.now() - (24 * 60 * 60 * 1000);
        
        setTimeout(async () => {
            await this.stopPushNotifications();
            await this.setupPushNotifications(process.env.WEBHOOK_URL);
        }, renewTime);
    }
    
    // Parar notificações
    async stopPushNotifications() {
        if (!this.channelId || !this.resourceId) return;
        
        try {
            const drive = this.driveClient.drive;
            
            await drive.channels.stop({
                requestBody: {
                    id: this.channelId,
                    resourceId: this.resourceId
                }
            });
            
            console.log('⏹️ Push Notifications paradas');
        } catch (error) {
            console.error('❌ Erro ao parar push notifications:', error.message);
        }
    }
    
    // Processar notificação recebida
    async handleNotification(headers) {
        const channelId = headers['x-goog-channel-id'];
        const resourceState = headers['x-goog-resource-state'];
        const resourceId = headers['x-goog-resource-id'];
        
        console.log(`📢 Notificação recebida: ${resourceState}`);
        
        // Verificar se é nosso canal
        if (channelId !== this.channelId) {
            console.log('⚠️ Notificação de canal desconhecido');
            return;
        }
        
        // Sincronizar apenas em mudanças relevantes
        if (resourceState === 'change' || resourceState === 'sync') {
            console.log('🔄 Sincronizando mudanças...');
            await this.syncManager.syncNow();
        }
    }
}

module.exports = RealtimeSync;
