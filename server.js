require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// ==========================================
// ======== CONFIGURAÇÃO DO SUPABASE ========
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucketName = process.env.SUPABASE_BUCKET_NAME || 'documentos';

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ ERRO: SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
console.log('✅ Supabase configurado:', supabaseUrl);
console.log('📦 Bucket:', bucketName);

// ==========================================
// ======== CONFIGURAÇÃO DO MULTER ==========
// ==========================================
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB
    }
});

// ==========================================
// ======== CORS ============================
// ==========================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Token', 'Accept'],
    credentials: false
}));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token, Accept');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log de requisições
app.use((req, res, next) => {
    console.log(`📥 ${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ==========================================
// ======== AUTENTICAÇÃO ====================
// ==========================================
const PORTAL_URL = process.env.PORTAL_URL || 'https://ir-comercio-portal-zcan.onrender.com';
console.log('🔐 Portal URL configurado:', PORTAL_URL);

async function verificarAutenticacao(req, res, next) {
    const publicPaths = ['/', '/health', '/app'];
    if (publicPaths.includes(req.path)) {
        return next();
    }

    const sessionToken = req.headers['x-session-token'] || req.query.sessionToken;

    if (!sessionToken) {
        return res.status(401).json({
            error: 'Não autenticado',
            message: 'Token de sessão não encontrado',
            redirectToLogin: true
        });
    }

    try {
        const verifyResponse = await fetch(`${PORTAL_URL}/api/verify-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionToken })
        });

        if (!verifyResponse.ok) {
            return res.status(401).json({
                error: 'Sessão inválida',
                message: 'Sua sessão expirou ou foi invalidada',
                redirectToLogin: true
            });
        }

        const sessionData = await verifyResponse.json();

        if (!sessionData.valid) {
            return res.status(401).json({
                error: 'Sessão inválida',
                message: sessionData.message || 'Sua sessão expirou',
                redirectToLogin: true
            });
        }

        req.user = sessionData.session;
        req.sessionToken = sessionToken;
        next();
    } catch (error) {
        console.error('❌ Erro ao verificar autenticação:', error);
        return res.status(500).json({
            error: 'Erro interno',
            message: 'Erro ao verificar autenticação'
        });
    }
}

// ==========================================
// ======== FUNÇÕES AUXILIARES ==============
// ==========================================

function normalizePath(inputPath) {
    if (!inputPath || inputPath === '/') return 'Documentos/';
    
    let normalized = inputPath.trim();
    
    if (normalized.startsWith('/')) {
        normalized = normalized.substring(1);
    }
    
    if (!normalized.startsWith('Documentos/')) {
        normalized = 'Documentos/' + normalized;
    }
    
    if (!normalized.endsWith('/')) {
        normalized += '/';
    }
    
    return normalized;
}

async function listarConteudoPasta(caminho) {
    try {
        const { data, error } = await supabase.storage
            .from(bucketName)
            .list(caminho, {
                limit: 1000,
                offset: 0
            });

        if (error) throw error;
        return data || [];
    } catch (error) {
        console.error('Erro ao listar pasta:', error);
        return [];
    }
}

// ==========================================
// ======== SERVIR ARQUIVOS ESTÁTICOS =======
// ==========================================
const publicPath = path.join(__dirname, 'public');
console.log('📁 Pasta public:', publicPath);

app.use(express.static(publicPath, {
    index: 'index.html',
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        } else if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
        } else if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        }
    }
}));

// ==========================================
// ======== HEALTH CHECK ====================
// ==========================================
app.get('/health', async (req, res) => {
    try {
        const { data, error } = await supabase.storage.listBuckets();
        
        res.json({
            status: error ? 'unhealthy' : 'healthy',
            storage: error ? 'disconnected' : 'connected',
            bucket: bucketName,
            portal_url: PORTAL_URL,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ==========================================
// ======== ROTAS DA API ====================
// ==========================================

app.use('/api', verificarAutenticacao);

// Busca global (recursiva em todas as pastas)
app.get('/api/search', async (req, res) => {
    try {
        const searchTerm = req.query.q?.toLowerCase() || '';
        
        if (!searchTerm || searchTerm.length < 2) {
            return res.json({ results: [] });
        }

        console.log('🔍 Buscando:', searchTerm);

        // Função recursiva para buscar em todas as pastas
        async function searchInFolder(folderPath) {
            const items = await listarConteudoPasta(folderPath);
            let results = [];

            for (const item of items) {
                const fullPath = folderPath + item.name;
                
                // Verifica se o nome do item contém o termo de busca
                if (item.name.toLowerCase().includes(searchTerm)) {
                    if (item.id) {
                        // É um arquivo
                        results.push({
                            name: item.name,
                            type: 'file',
                            path: fullPath,
                            size: item.metadata?.size || 0,
                            mimetype: item.metadata?.mimetype || 'application/octet-stream',
                            folder: folderPath,
                            created_at: item.created_at,
                            updated_at: item.updated_at
                        });
                    } else {
                        // É uma pasta
                        results.push({
                            name: item.name,
                            type: 'folder',
                            path: fullPath + '/',
                            folder: folderPath,
                            created_at: item.created_at,
                            updated_at: item.updated_at
                        });
                    }
                }

                // Se for pasta, buscar dentro dela também (recursivo)
                if (!item.id) {
                    const subResults = await searchInFolder(fullPath + '/');
                    results = results.concat(subResults);
                }
            }

            return results;
        }

        const results = await searchInFolder('Documentos/');
        
        console.log(`✅ ${results.length} resultados encontrados`);
        res.json({ results });
    } catch (error) {
        console.error('❌ Erro na busca:', error);
        res.status(500).json({ 
            error: 'Erro ao buscar', 
            details: error.message 
        });
    }
});

// Listar conteúdo de uma pasta
app.get('/api/folders', async (req, res) => {
    try {
        const caminho = normalizePath(req.query.path || '/');
        console.log('📂 Listando:', caminho);

        const items = await listarConteudoPasta(caminho);

        const pastas = items.filter(item => !item.id).map(item => ({
            name: item.name,
            type: 'folder',
            path: caminho + item.name + '/',
            created_at: item.created_at,
            updated_at: item.updated_at
        }));

        const arquivos = items.filter(item => item.id).map(item => ({
            name: item.name,
            type: 'file',
            path: caminho + item.name,
            size: item.metadata?.size || 0,
            mimetype: item.metadata?.mimetype || 'application/octet-stream',
            created_at: item.created_at,
            updated_at: item.updated_at,
            id: item.id
        }));

        res.json({
            currentPath: caminho,
            folders: pastas,
            files: arquivos,
            total: pastas.length + arquivos.length
        });
    } catch (error) {
        console.error('❌ Erro ao listar pasta:', error);
        res.status(500).json({ 
            error: 'Erro ao listar pasta', 
            details: error.message 
        });
    }
});

// Criar nova pasta
app.post('/api/folders', async (req, res) => {
    try {
        const { path: parentPath, name } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Nome da pasta é obrigatório' });
        }

        const normalizedParent = normalizePath(parentPath || '/');
        const newFolderPath = normalizedParent + name + '/';

        console.log('📁 Criando pasta:', newFolderPath);

        const { error } = await supabase.storage
            .from(bucketName)
            .upload(newFolderPath + '.keep', new Blob([''], { type: 'text/plain' }), {
                cacheControl: '3600',
                upsert: false
            });

        if (error) {
            if (error.message.includes('already exists')) {
                return res.status(409).json({ error: 'Pasta já existe' });
            }
            throw error;
        }

        res.status(201).json({
            message: 'Pasta criada com sucesso',
            path: newFolderPath,
            name: name
        });
    } catch (error) {
        console.error('❌ Erro ao criar pasta:', error);
        res.status(500).json({ 
            error: 'Erro ao criar pasta', 
            details: error.message 
        });
    }
});

// Upload de arquivo
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nenhum arquivo enviado' });
        }

        const { path: uploadPath } = req.body;
        const normalizedPath = normalizePath(uploadPath || '/');
        const filePath = normalizedPath + req.file.originalname;

        console.log('📤 Upload:', filePath);

        const { data, error } = await supabase.storage
            .from(bucketName)
            .upload(filePath, req.file.buffer, {
                contentType: req.file.mimetype,
                cacheControl: '3600',
                upsert: false
            });

        if (error) {
            if (error.message.includes('already exists')) {
                return res.status(409).json({ error: 'Arquivo já existe' });
            }
            throw error;
        }

        res.status(201).json({
            message: 'Arquivo enviado com sucesso',
            file: {
                name: req.file.originalname,
                path: filePath,
                size: req.file.size,
                mimetype: req.file.mimetype
            }
        });
    } catch (error) {
        console.error('❌ Erro no upload:', error);
        res.status(500).json({ 
            error: 'Erro ao fazer upload', 
            details: error.message 
        });
    }
});

// Download de arquivo
app.get('/api/download', async (req, res) => {
    try {
        const { path: filePath } = req.query;
        
        if (!filePath) {
            return res.status(400).json({ error: 'Caminho do arquivo não fornecido' });
        }

        console.log('📥 Download:', filePath);

        const { data, error } = await supabase.storage
            .from(bucketName)
            .download(filePath);

        if (error) throw error;

        const fileName = filePath.split('/').pop();
        
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        const buffer = Buffer.from(await data.arrayBuffer());
        res.send(buffer);
    } catch (error) {
        console.error('❌ Erro no download:', error);
        res.status(500).json({ 
            error: 'Erro ao baixar arquivo', 
            details: error.message 
        });
    }
});

// Deletar arquivo ou pasta
app.delete('/api/delete', async (req, res) => {
    try {
        const { path: itemPath, type } = req.query;
        
        if (!itemPath) {
            return res.status(400).json({ error: 'Caminho não fornecido' });
        }

        console.log('🗑️ Deletando:', itemPath, '(Tipo:', type, ')');

        if (type === 'folder') {
            const items = await listarConteudoPasta(itemPath);
            const allFiles = items.map(item => itemPath + item.name);
            
            if (allFiles.length > 0) {
                const { error } = await supabase.storage
                    .from(bucketName)
                    .remove(allFiles);

                if (error) throw error;
            }
        } else {
            const { error } = await supabase.storage
                .from(bucketName)
                .remove([itemPath]);

            if (error) throw error;
        }

        res.json({ message: 'Item deletado com sucesso' });
    } catch (error) {
        console.error('❌ Erro ao deletar:', error);
        res.status(500).json({ 
            error: 'Erro ao deletar item', 
            details: error.message 
        });
    }
});

// Renomear arquivo ou pasta
app.put('/api/rename', async (req, res) => {
    try {
        const { oldPath, newName, type } = req.body;
        
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'Caminho antigo e novo nome são obrigatórios' });
        }

        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/') + 1);
        const newPath = parentPath + newName + (type === 'folder' ? '/' : '');

        console.log('✏️ Renomeando:', oldPath, '→', newPath);

        if (type === 'folder') {
            const items = await listarConteudoPasta(oldPath);
            
            for (const item of items) {
                const oldFilePath = oldPath + item.name;
                const newFilePath = newPath + item.name;
                
                const { error: moveError } = await supabase.storage
                    .from(bucketName)
                    .move(oldFilePath, newFilePath);

                if (moveError) throw moveError;
            }
        } else {
            const { error } = await supabase.storage
                .from(bucketName)
                .move(oldPath, newPath);

            if (error) throw error;
        }

        res.json({ 
            message: 'Item renomeado com sucesso',
            newPath: newPath
        });
    } catch (error) {
        console.error('❌ Erro ao renomear:', error);
        res.status(500).json({ 
            error: 'Erro ao renomear item', 
            details: error.message 
        });
    }
});

// ==========================================
// ======== ROTAS PRINCIPAIS ================
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.get('/app', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

// ==========================================
// ======== 404 =============================
// ==========================================
app.use((req, res) => {
    res.status(404).json({
        error: '404 - Rota não encontrada',
        path: req.path
    });
});

// ==========================================
// ======== ERRO ============================
// ==========================================
app.use((error, req, res, next) => {
    console.error('💥 Erro:', error);
    res.status(500).json({
        error: 'Erro interno do servidor',
        message: error.message
    });
});

// ==========================================
// ======== INICIAR SERVIDOR ================
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 ================================');
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📦 Storage: Supabase`);
    console.log(`🪣 Bucket: ${bucketName}`);
    console.log(`🔗 Supabase URL: ${supabaseUrl}`);
    console.log(`🔐 Autenticação: Portal ✅`);
    console.log(`🌐 Portal URL: ${PORTAL_URL}`);
    console.log('🚀 ================================\n');
});

if (!fs.existsSync(publicPath)) {
    console.error('⚠️ AVISO: Pasta public/ não encontrada!');
}
