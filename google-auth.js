// google-auth.js - Autenticação Google Drive
const { google } = require('googleapis');

class GoogleAuth {
    constructor(clientId, clientSecret, redirectUri, supabase) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.redirectUri = redirectUri;
        this.supabase = supabase;
        
        this.oauth2Client = new google.auth.OAuth2(
            this.clientId,
            this.clientSecret,
            this.redirectUri
        );
        
        this.scopes = [
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.file'
        ];
    }
    
    // Gerar URL de autenticação
    getAuthUrl() {
        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: this.scopes,
            prompt: 'consent' // Força novo refresh token
        });
    }
    
    // Trocar código por token
    async getTokenFromCode(code) {
        const { tokens } = await this.oauth2Client.getToken(code);
        this.oauth2Client.setCredentials(tokens);
        
        // Salvar no Supabase
        await this.saveToken(tokens);
        
        return tokens;
    }
    
    // Obter cliente autenticado
    getClient() {
        return this.oauth2Client;
    }
    
    // Renovar token
    async refreshToken() {
        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);
        
        // Atualizar no Supabase
        await this.saveToken(credentials);
        
        return credentials;
    }
    
    // Salvar token no Supabase
    async saveToken(tokens) {
        const expiresAt = new Date(Date.now() + (tokens.expiry_date || 3600000));
        
        await this.supabase
            .from('google_tokens')
            .insert({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expires_at: expiresAt.toISOString()
            });
    }
    
    // Carregar token do Supabase
    async loadToken() {
        const { data, error } = await this.supabase
            .from('google_tokens')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
        
        if (error || !data) {
            return false;
        }
        
        const tokens = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expiry_date: new Date(data.expires_at).getTime()
        };
        
        this.oauth2Client.setCredentials(tokens);
        
        // Verificar se expirou
        if (Date.now() >= tokens.expiry_date) {
            await this.refreshToken();
        }
        
        return true;
    }
    
    // Verificar se está autenticado
    async isAuthenticated() {
        const creds = this.oauth2Client.credentials;
        if (creds && creds.access_token) {
            return true;
        }
        return await this.loadToken();
    }
}

module.exports = GoogleAuth;
