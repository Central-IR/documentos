// zip-manager.js - Gerenciador de Compactação ZIP
const archiver = require('archiver');
const { Readable } = require('stream');

class ZipManager {
    constructor(driveClient) {
        this.driveClient = driveClient;
    }
    
    // Criar ZIP de múltiplos arquivos
    async createZip(fileIds, zipName = 'arquivos.zip') {
        return new Promise(async (resolve, reject) => {
            try {
                const archive = archiver('zip', {
                    zlib: { level: 9 } // Máxima compressão
                });
                
                const chunks = [];
                
                archive.on('data', chunk => chunks.push(chunk));
                archive.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    resolve(buffer);
                });
                archive.on('error', reject);
                
                // Adicionar cada arquivo ao ZIP
                for (const fileId of fileIds) {
                    try {
                        // Obter informações do arquivo
                        const fileInfo = await this.driveClient.getFile(fileId);
                        
                        // Download do arquivo
                        const stream = await this.driveClient.downloadFile(fileId);
                        
                        // Adicionar ao ZIP
                        archive.append(stream, { name: fileInfo.name });
                        
                        console.log(`📦 Adicionado ao ZIP: ${fileInfo.name}`);
                    } catch (error) {
                        console.error(`❌ Erro ao adicionar ${fileId}:`, error.message);
                    }
                }
                
                // Finalizar ZIP
                await archive.finalize();
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    // Criar ZIP de uma pasta inteira
    async createFolderZip(folderId, folderName = 'pasta') {
        return new Promise(async (resolve, reject) => {
            try {
                const archive = archiver('zip', {
                    zlib: { level: 9 }
                });
                
                const chunks = [];
                
                archive.on('data', chunk => chunks.push(chunk));
                archive.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    resolve(buffer);
                });
                archive.on('error', reject);
                
                // Obter todos os arquivos da pasta (recursivo)
                const files = await this.getAllFilesInFolder(folderId);
                
                // Adicionar cada arquivo
                for (const file of files) {
                    if (file.mimeType !== 'application/vnd.google-apps.folder') {
                        try {
                            const stream = await this.driveClient.downloadFile(file.id);
                            archive.append(stream, { name: file.path });
                            console.log(`📦 Adicionado: ${file.path}`);
                        } catch (error) {
                            console.error(`❌ Erro: ${file.name}`, error.message);
                        }
                    }
                }
                
                await archive.finalize();
                
            } catch (error) {
                reject(error);
            }
        });
    }
    
    // Obter todos os arquivos de uma pasta (recursivo)
    async getAllFilesInFolder(folderId, basePath = '') {
        const drive = this.driveClient.drive;
        const results = [];
        
        const response = await drive.files.list({
            q: `'${folderId}' in parents and trashed=false`,
            fields: 'files(id, name, mimeType)',
            pageSize: 1000
        });
        
        const files = response.data.files || [];
        
        for (const file of files) {
            const filePath = basePath ? `${basePath}/${file.name}` : file.name;
            
            if (file.mimeType === 'application/vnd.google-apps.folder') {
                // Recursivo para subpastas
                const subFiles = await this.getAllFilesInFolder(file.id, filePath);
                results.push(...subFiles);
            } else {
                results.push({
                    id: file.id,
                    name: file.name,
                    path: filePath,
                    mimeType: file.mimeType
                });
            }
        }
        
        return results;
    }
    
    // Upload de ZIP para o Drive
    async uploadZipToDrive(buffer, zipName, parentFolderId) {
        const stream = Readable.from(buffer);
        
        const response = await this.driveClient.drive.files.create({
            requestBody: {
                name: zipName,
                parents: [parentFolderId],
                mimeType: 'application/zip'
            },
            media: {
                mimeType: 'application/zip',
                body: stream
            },
            fields: 'id, name, webContentLink, webViewLink'
        });
        
        // Tornar público
        await this.driveClient.drive.permissions.create({
            fileId: response.data.id,
            requestBody: {
                role: 'reader',
                type: 'anyone'
            }
        });
        
        return response.data;
    }
}

module.exports = ZipManager;
