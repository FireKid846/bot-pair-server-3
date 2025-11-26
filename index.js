const { Telegraf, Markup } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, Browsers, delay, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const P = require('pino');
const os = require('os');
const https = require('https');
const http = require('http');
require('dotenv').config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const logger = P({ level: 'silent' });

const userData = new Map();
const activeRequests = new Map();
const rateLimiter = new Map();
const activeSessions = new Map();
const bannedUsers = new Set();
const verifiedUsers = new Set(); // NEW: Persistent verified users storage
const botStartTime = Date.now();

const RATE_LIMIT_WINDOW = 24 * 60 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 2;
const CONNECTION_TIMEOUT = 180000;
const MAX_RETRIES = 2;
const PING_INTERVAL = 10 * 60 * 1000;
const CLEANUP_INTERVAL = 3 * 60 * 1000;
const REQUEST_TIMEOUT = 3 * 60 * 1000;
const REQUIRED_CHANNEL = '@firekid_ios';

class GitHubSessionStorage {
    constructor() {
        this.githubToken = process.env.GITHUB_TOKEN;
        this.repoUrl = process.env.GITHUB_REPO_URL;
        
        if (!this.githubToken || !this.repoUrl) {
            throw new Error('GITHUB_TOKEN and GITHUB_REPO_URL must be set');
        }

        const repoMatch = this.repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
        if (!repoMatch) {
            throw new Error('Invalid GITHUB_REPO_URL format');
        }

        this.repoName = repoMatch[2];
        this.repoPath = path.join(__dirname, this.repoName);
        this.sessionsPath = path.join(this.repoPath, 'sessions');
        this.indexPath = path.join(this.sessionsPath, 'index.json');
        this.initializeRepo();
    }

    initializeRepo() {
        try {
            if (fs.existsSync(this.repoPath)) {
                fs.rmSync(this.repoPath, { recursive: true, force: true });
            }

            const cloneUrl = this.repoUrl.replace('https://github.com/', `https://${this.githubToken}@github.com/`);
            execSync(`git clone "${cloneUrl}"`, { cwd: __dirname, stdio: 'pipe' });

            if (!fs.existsSync(this.sessionsPath)) {
                fs.mkdirSync(this.sessionsPath, { recursive: true });
            }

            if (!fs.existsSync(this.indexPath)) {
                const initialIndex = {
                    version: "1.0.0",
                    created: new Date().toISOString(),
                    sessions: {},
                    stats: { totalSessions: 0, lastUpdated: new Date().toISOString() }
                };
                fs.writeFileSync(this.indexPath, JSON.stringify(initialIndex, null, 2));
            }

            try {
                execSync('git config user.name "Firekid Bot"', { cwd: this.repoPath, stdio: 'pipe' });
                execSync('git config user.email "bot@firekid.com"', { cwd: this.repoPath, stdio: 'pipe' });
            } catch (e) {}

        } catch (error) {
            console.error('Repo init error:', error.message);
        }
    }

    async saveSession(sessionId, phoneNumber, authDir, userId) {
        try {
            if (!fs.existsSync(this.repoPath)) {
                return { success: false };
            }

            const sessionDir = path.join(this.sessionsPath, sessionId);
            if (!fs.existsSync(sessionDir)) {
                fs.mkdirSync(sessionDir, { recursive: true });
            }

            const authFiles = fs.readdirSync(authDir);
            const copiedFiles = [];

            for (const file of authFiles) {
                const srcPath = path.join(authDir, file);
                const destPath = path.join(sessionDir, file);

                if (fs.statSync(srcPath).isFile()) {
                    fs.copyFileSync(srcPath, destPath);
                    copiedFiles.push(file);
                }
            }

            const sessionData = {
                sessionId, phoneNumber, userId,
                created: new Date().toISOString(),
                files: copiedFiles, status: 'active',
                lastAccessed: new Date().toISOString()
            };

            fs.writeFileSync(path.join(sessionDir, 'metadata.json'), JSON.stringify(sessionData, null, 2));

            const index = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
            index.sessions[sessionId] = {
                sessionId, phoneNumber: phoneNumber.replace(/(\d{3})\d*(\d{4})/, '$1****$2'),
                userId, created: sessionData.created, status: 'active', fileCount: copiedFiles.length
            };

            index.stats.totalSessions = Object.keys(index.sessions).length;
            index.stats.lastUpdated = new Date().toISOString();
            fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));

            await this.pushToGitHub(`Add session ${sessionId}`);

            return { success: true, sessionId, filesStored: copiedFiles.length };

        } catch (error) {
            return { success: false };
        }
    }

    async pushToGitHub(commitMessage) {
        try {
            try {
                execSync('git pull origin main --rebase', { cwd: this.repoPath, stdio: 'pipe' });
            } catch (pullError) {
                execSync('git fetch origin', { cwd: this.repoPath, stdio: 'pipe' });
                execSync('git reset --hard origin/main', { cwd: this.repoPath, stdio: 'pipe' });
            }

            execSync('git add .', { cwd: this.repoPath, stdio: 'pipe' });

            try {
                execSync('git diff --staged --quiet', { cwd: this.repoPath, stdio: 'pipe' });
                return;
            } catch (e) {}

            try {
                execSync(`git commit -m "${commitMessage}"`, { cwd: this.repoPath, stdio: 'pipe' });
            } catch (commitError) {
                if (commitError.message.includes('nothing to commit')) return;
                throw commitError;
            }

            let pushAttempts = 0;
            while (pushAttempts < 3) {
                try {
                    execSync('git push origin main', { cwd: this.repoPath, stdio: 'pipe' });
                    return;
                } catch (pushError) {
                    pushAttempts++;
                    if (pushAttempts < 3) {
                        execSync('git pull origin main --rebase', { cwd: this.repoPath, stdio: 'pipe' });
                    } else {
                        throw pushError;
                    }
                }
            }
        } catch (error) {
            throw error;
        }
    }
}

const gitHubStorage = new GitHubSessionStorage();

function getUserData(userId) {
    if (!userData.has(userId)) {
        userData.set(userId, { 
            verified: verifiedUsers.has(userId), // Load from persistent storage
            pairHistory: [], 
            lastRequest: 0 
        });
    }
    return userData.get(userId);
}

function isUserVerified(userId, username) {
    if (username === 'firekidffx') return true;
    return verifiedUsers.has(userId); // Check persistent storage
}

function isAdmin(username) {
    return username === 'firekidffx';
}

function isBanned(userId) {
    return bannedUsers.has(userId);
}

function checkRateLimit(userId, username) {
    if (username === 'firekidffx') return true;

    const now = Date.now();
    const userLimits = rateLimiter.get(userId) || { count: 0, windowStart: now };

    if (now - userLimits.windowStart > RATE_LIMIT_WINDOW) {
        userLimits.count = 0;
        userLimits.windowStart = now;
    }

    if (userLimits.count >= MAX_REQUESTS_PER_WINDOW) {
        return false;
    }

    userLimits.count++;
    rateLimiter.set(userId, userLimits);
    return true;
}

function formatPhoneNumber(phone) {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length < 10 || cleaned.length > 15) return null;
    return cleaned;
}

function createAuthDir(userId) {
    const authDir = path.join(__dirname, `auth_${userId}_${Date.now()}`);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }
    return authDir;
}

function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function selfPing() {
    if (!process.env.RENDER_EXTERNAL_URL) {
        console.log('⚠️ RENDER_EXTERNAL_URL not set, skipping self-ping');
        return;
    }

    const url = process.env.RENDER_EXTERNAL_URL;
    const protocol = url.startsWith('https') ? https : http;

    console.log(`🔄 Self-ping enabled for: ${url}`);
    console.log(`⏰ Ping interval: ${PING_INTERVAL / 60000} minutes`);

    setInterval(() => {
        const pingTime = new Date().toISOString();
        protocol.get(url, (res) => {
            console.log(`✅ Self-ping successful [${pingTime}]: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`❌ Self-ping error [${pingTime}]:`, err.message);
        });
    }, PING_INTERVAL);
}

async function cleanupSocket(socket) {
    if (!socket) return;
    try {
        socket.ev.removeAllListeners();
        socket.end();
    } catch (e) {
        console.error('Socket cleanup error:', e.message);
    }
}

function cleanupStaleRequests() {
    const now = Date.now();
    const staleRequests = [];

    for (const [userId, data] of activeRequests) {
        if (now - data.timestamp > REQUEST_TIMEOUT) {
            staleRequests.push(userId);
        }
    }

    staleRequests.forEach(userId => {
        activeRequests.delete(userId);
        console.log(`🧹 Cleaned stale request for user ${userId}`);
    });
    
    if (staleRequests.length > 0) {
        console.log(`✅ Cleaned ${staleRequests.length} stale request(s)`);
    }
}

function cleanupStaleSessions() {
    const now = Date.now();
    const staleSessions = [];

    for (const [sessionId, data] of activeSessions) {
        if (sessionId.startsWith('temp_') && now - data.timestamp > CLEANUP_INTERVAL) {
            staleSessions.push(sessionId);
        }
    }

    staleSessions.forEach(async sessionId => {
        const data = activeSessions.get(sessionId);
        if (data) {
            await cleanupSocket(data.socket);
            if (data.authDir && fs.existsSync(data.authDir)) {
                try {
                    fs.rmSync(data.authDir, { recursive: true, force: true });
                } catch (e) {
                    console.error('Auth dir cleanup error:', e.message);
                }
            }
        }
        activeSessions.delete(sessionId);
        console.log(`🧹 Cleaned stale session ${sessionId}`);
    });
    
    if (staleSessions.length > 0) {
        console.log(`✅ Cleaned ${staleSessions.length} stale session(s)`);
    }
}

function cleanupOrphanedAuthDirs() {
    try {
        const files = fs.readdirSync(__dirname);
        const now = Date.now();

        files.forEach(file => {
            if (file.startsWith('auth_')) {
                const dirPath = path.join(__dirname, file);
                try {
                    const stat = fs.statSync(dirPath);
                    if (now - stat.mtimeMs > CLEANUP_INTERVAL) {
                        fs.rmSync(dirPath, { recursive: true, force: true });
                        console.log(`Cleaned orphaned auth dir: ${file}`);
                    }
                } catch (e) {
                    console.error(`Error cleaning ${file}:`, e.message);
                }
            }
        });
    } catch (error) {
        console.error('Orphaned cleanup error:', error.message);
    }
}

function startCleanupScheduler() {
    setInterval(() => {
        cleanupStaleRequests();
        cleanupStaleSessions();
        cleanupOrphanedAuthDirs();
    }, CLEANUP_INTERVAL);

    console.log(`🧹 Cleanup scheduler started (every ${CLEANUP_INTERVAL / 60000} minutes)`);
}

async function handleSuccessfulConnection(socket, sessionId, phoneNumber, userId, authDir) {
    try {
        activeSessions.delete(`temp_${userId}_${phoneNumber}`);
        
        let githubSaveSuccess = false;
        try {
            const saveResult = await gitHubStorage.saveSession(sessionId, phoneNumber, authDir, userId);
            githubSaveSuccess = saveResult.success;
        } catch (saveError) {
            console.error('GitHub save error:', saveError);
        }

        activeSessions.set(sessionId, {
            userId, phoneNumber, timestamp: Date.now(),
            status: 'connected', socket, authDir, savedToGitHub: githubSaveSuccess
        });

        const imageUrls = [
            'https://ik.imagekit.io/firekid/photo_2025-09-08_14-11-15.jpg',
            'https://ik.imagekit.io/firekid/photo_2025-09-08_13-31-44.jpg',
            'https://ik.imagekit.io/firekid/photo_2025-09-08_13-34-15.jpg'
        ];
        const randomImage = imageUrls[Math.floor(Math.random() * imageUrls.length)];

        const welcomeMessage = `Firekid Bot - Connected\n\n` +
            `Your WhatsApp is now paired.\n\n` +
            `Features:\n` +
            `• Automated replies\n` +
            `• Smart notifications\n` +
            `• Advanced tools\n\n` +
            `Built by Firekid`;

        const sessionMessage = `Session ID: ${sessionId}`;

        try {
            await delay(3000);
            await socket.sendMessage(`${phoneNumber}@s.whatsapp.net`, { 
                image: { url: randomImage }, caption: welcomeMessage 
            });
            await delay(2000);
            await socket.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text: sessionMessage });
        } catch (e) {
            console.error('WhatsApp message error:', e.message);
        }

        try {
            await bot.telegram.sendPhoto(userId, randomImage, { caption: welcomeMessage });
            await bot.telegram.sendMessage(userId, sessionMessage, 
                Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'back_menu')]])
            );
        } catch (telegramError) {
            console.error('Telegram message error:', telegramError.message);
        }

    } catch (error) {
        console.error('Connection handler error:', error.message);
    }
}

async function generatePairingCode(phoneNumber, userId, retryCount = 0) {
    for (const [sessionId, data] of activeSessions) {
        if (data.userId === userId && (data.status === 'waiting_for_auth' || data.status === 'connecting')) {
            console.log(`🧹 Force cleaning old waiting session for user ${userId}`);
            await cleanupSocket(data.socket);
            activeSessions.delete(sessionId);
        }
    }
    
    const authDir = createAuthDir(userId);
    let socket = null;
    let reconnectSocket = null;
    let connectionTimeout = null;

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        
        const msgRetryCounterCache = new NodeCache({ stdTTL: 600, useClones: false });

        socket = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger,
            printQRInTerminal: false,
            browser: Browsers.macOS('Chrome'),
            connectTimeoutMs: CONNECTION_TIMEOUT,
            keepAliveIntervalMs: 30000,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            msgRetryCounterCache,
            generateHighQualityLinkPreview: false,
            getMessage: async () => undefined
        });

        socket.ev.on('creds.update', saveCreds);

        const result = await new Promise((resolve, reject) => {
            let hasRequestedCode = false;
            let codeGenerated = false;
            let authSuccess = false;
            let isReconnecting = false;

            connectionTimeout = setTimeout(() => {
                if (!authSuccess) {
                    cleanupSocket(socket);
                    cleanupSocket(reconnectSocket);
                    reject(new Error('Connection timeout'));
                }
            }, CONNECTION_TIMEOUT);

            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (!hasRequestedCode && !codeGenerated && !authSuccess) {
                    if (connection === 'connecting' || qr) {
                        hasRequestedCode = true;

                        try {
                            await delay(2000);
                            const code = await socket.requestPairingCode(phoneNumber);
                            codeGenerated = true;

                            activeSessions.set(`temp_${userId}_${phoneNumber}`, {
                                userId, phoneNumber, timestamp: Date.now(),
                                status: 'waiting_for_auth', socket, authDir
                            });

                            resolve({ code });

                        } catch (error) {
                            clearTimeout(connectionTimeout);
                            const statusCode = error.output?.statusCode;

                            if (statusCode === 428 || statusCode === 405 || error.message.includes('Connection Closed')) {
                                if (retryCount < MAX_RETRIES) {
                                    await cleanupSocket(socket);
                                    const waitTime = (retryCount + 1) * 20000;
                                    await delay(waitTime);
                                    reject({ retry: true, retryCount: retryCount + 1 });
                                } else {
                                    reject(new Error('WhatsApp blocked requests. Try again in 2-4 hours.'));
                                }
                            } else if (statusCode === 403) {
                                reject(new Error('Number blocked. Use different number.'));
                            } else if (statusCode === 429) {
                                reject(new Error('Rate limited. Wait 2 hours.'));
                            } else {
                                reject(new Error(`Failed: ${error.message || 'Unknown error'}`));
                            }
                        }
                    }
                }

                if (connection === 'open' && !isReconnecting) {
                    authSuccess = true;
                    clearTimeout(connectionTimeout);
                    socket.ev.removeAllListeners('connection.update');

                    const sessionId = crypto.randomBytes(8).toString('hex').toUpperCase();
                    await handleSuccessfulConnection(socket, sessionId, phoneNumber, userId, authDir);
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                        if (codeGenerated && !authSuccess && !isReconnecting) {
                            isReconnecting = true;

                            try {
                                await delay(2000);
                                await cleanupSocket(socket);

                                const { state: newState, saveCreds: newSaveCreds } = await useMultiFileAuthState(authDir);
                                const newMsgCache = new NodeCache({ stdTTL: 600, useClones: false });

                                reconnectSocket = makeWASocket({
                                    version,
                                    auth: {
                                        creds: newState.creds,
                                        keys: makeCacheableSignalKeyStore(newState.keys, logger)
                                    },
                                    logger,
                                    printQRInTerminal: false,
                                    browser: Browsers.macOS('Chrome'),
                                    connectTimeoutMs: CONNECTION_TIMEOUT,
                                    keepAliveIntervalMs: 30000,
                                    markOnlineOnConnect: false,
                                    syncFullHistory: false,
                                    msgRetryCounterCache: newMsgCache,
                                    generateHighQualityLinkPreview: false,
                                    getMessage: async () => undefined
                                });

                                reconnectSocket.ev.on('creds.update', newSaveCreds);

                                reconnectSocket.ev.on('connection.update', async (reconnectUpdate) => {
                                    if (reconnectUpdate.connection === 'open') {
                                        authSuccess = true;
                                        clearTimeout(connectionTimeout);
                                        reconnectSocket.ev.removeAllListeners('connection.update');

                                        const sessionId = crypto.randomBytes(8).toString('hex').toUpperCase();
                                        await handleSuccessfulConnection(reconnectSocket, sessionId, phoneNumber, userId, authDir);
                                    }

                                    if (reconnectUpdate.connection === 'close' && !authSuccess) {
                                        clearTimeout(connectionTimeout);
                                        await cleanupSocket(reconnectSocket);
                                        reject(new Error('Reconnect failed. Try again.'));
                                    }
                                });

                            } catch (reconnectError) {
                                clearTimeout(connectionTimeout);
                                await cleanupSocket(reconnectSocket);
                                reject(new Error('Reconnect failed'));
                            }
                        }
                        return;
                    }

                    if (!codeGenerated && !authSuccess) {
                        clearTimeout(connectionTimeout);
                        await cleanupSocket(socket);

                        if (statusCode === 428 || statusCode === 405) {
                            if (retryCount < MAX_RETRIES) {
                                const waitTime = (retryCount + 1) * 20000;
                                await delay(waitTime);
                                reject({ retry: true, retryCount: retryCount + 1 });
                            } else {
                                reject(new Error('WhatsApp rejected connection. Try in 2-4 hours.'));
                            }
                        } else {
                            reject(new Error('Connection failed'));
                        }
                    }
                }
            });
        });

        return result;

    } catch (error) {
        await cleanupSocket(socket);
        await cleanupSocket(reconnectSocket);
        if (connectionTimeout) clearTimeout(connectionTimeout);

        if (error.retry) {
            try {
                await bot.telegram.sendMessage(
                    userId,
                    `Retrying... (${error.retryCount + 1}/${MAX_RETRIES + 1})`
                );
            } catch (e) {}

            return generatePairingCode(phoneNumber, userId, error.retryCount);
        }

        throw error;
    } finally {
        setTimeout(() => {
            try {
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                }
            } catch (e) {}
        }, 300000);
    }
}

async function isUserInChannel(userId) {
    try {
        const member = await bot.telegram.getChatMember(REQUIRED_CHANNEL, userId);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (error) {
        return false;
    }
}

function showAdminMenu(ctx) {
    const totalUsers = userData.size;
    const totalSessions = activeSessions.size;
    const totalBanned = bannedUsers.size;
    const uptime = formatUptime(Date.now() - botStartTime);

    const message = `╔════════════════════════╗\n` +
        `║      ADMIN PANEL       ║\n` +
        `╚════════════════════════╝\n\n` +
        `📊 Statistics\n` +
        `├ Users: ${totalUsers}\n` +
        `├ Sessions: ${totalSessions}\n` +
        `├ Banned: ${totalBanned}\n` +
        `└ Uptime: ${uptime}`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📝 User Management', 'admin_users')],
        [Markup.button.callback('🔧 System & Sessions', 'admin_system')],
        [Markup.button.callback('📢 Communication', 'admin_communication')],
        [Markup.button.callback('🔗 Generate Code (Admin)', 'admin_generate')],
        [Markup.button.callback('🔙 Back', 'back_main')]
    ]);

    if (ctx.callbackQuery) {
        ctx.editMessageText(message, keyboard);
    } else {
        ctx.reply(message, keyboard);
    }
}

function showMainMenu(ctx) {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    const user = getUserData(userId);
    const rateLimitInfo = rateLimiter.get(userId);

    let remaining;
    if (username === 'firekidffx') {
        remaining = 'Unlimited';
    } else {
        remaining = rateLimitInfo ? Math.max(0, MAX_REQUESTS_PER_WINDOW - rateLimitInfo.count) : MAX_REQUESTS_PER_WINDOW;
        remaining = `${remaining}/${MAX_REQUESTS_PER_WINDOW}`;
    }

    const message = `Firekid Pairing Bot\n\n` +
        `User: ${ctx.from.first_name}\n` +
        `User ID: \`${userId}\`\n` +
        `Total Codes: ${user.pairHistory.length}\n` +
        `Remaining: ${remaining}\n\n` +
        `Limit: 2 codes per 24 hours`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Get Code', 'get_pairing')],
        [Markup.button.callback('Disconnect', 'disconnect_session')],
        [Markup.button.callback('Support', 'contact_support')],
        [Markup.button.callback('Help', 'show_help')]
    ]);

    if (ctx.callbackQuery) {
        ctx.editMessageText(message, { ...keyboard, parse_mode: 'Markdown' });
    } else {
        ctx.reply(message, { ...keyboard, parse_mode: 'Markdown' });
    }
}

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;

    if (isBanned(userId)) {
        return ctx.reply('You are banned.');
    }

    if (isAdmin(username)) {
        return showAdminMenu(ctx);
    }

    // Check if user is in channel
    const isMember = await isUserInChannel(userId);
    
    if (isMember) {
        // User is in channel - add to verified and show main menu
        verifiedUsers.add(userId);
        getUserData(userId).verified = true;
        return showMainMenu(ctx);
    }

    // User not in channel - show verification
    ctx.reply(
        'Welcome to Firekid Pairing Bot\n\nFollow our channels:',
        Markup.inlineKeyboard([
            [Markup.button.url('TikTok', 'https://www.tiktok.com/@firekid846')],
            [Markup.button.url('WhatsApp', 'https://whatsapp.com/channel/0029VaT1YDxFsn0oKfK81n2R')],
            [Markup.button.url('Telegram', 'https://t.me/firekid_ios')],
            [Markup.button.callback('Verify', 'verify_start')]
        ])
    );
});

bot.action('admin_generate', async (ctx) => {
    if (!isAdmin(ctx.from.username)) {
        try {
            await ctx.answerCbQuery('Admin only');
        } catch (e) {}
        return;
    }

    try {
        await ctx.answerCbQuery('Send phone number');
    } catch (e) {}
    
    activeRequests.set(ctx.from.id, { status: 'admin_waiting_number', timestamp: Date.now() });

    try {
        await ctx.editMessageText(
            '🔐 ADMIN: Generate Pairing Code\n\n' +
            'Send phone number (no rate limit)\n\n' +
            'Format: Country code + number\n' +
            'Example: 2348123456789',
            Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'admin_menu')]])
        );
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
    }
});

bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx.from.username)) return;

    const message = ctx.message.text.replace('/broadcast', '').trim();
    if (!message) {
        return ctx.reply('Usage: /broadcast <message>');
    }

    let sent = 0;
    let failed = 0;

    for (const [userId] of userData) {
        try {
            await ctx.telegram.sendMessage(userId, `Broadcast:\n\n${message}`);
            sent++;
            await delay(100);
        } catch (e) {
            failed++;
        }
    }

    ctx.reply(`Sent: ${sent}\nFailed: ${failed}`);
});

bot.command('ban', async (ctx) => {
    if (!isAdmin(ctx.from.username)) return;

    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('Usage: /ban <userId>');
    }

    const userId = parseInt(args[1]);
    if (isNaN(userId)) {
        return ctx.reply('Invalid user ID');
    }

    bannedUsers.add(userId);
    ctx.reply(`User ${userId} banned`);
});

bot.command('unban', async (ctx) => {
    if (!isAdmin(ctx.from.username)) return;

    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('Usage: /unban <userId>');
    }

    const userId = parseInt(args[1]);
    if (isNaN(userId)) {
        return ctx.reply('Invalid user ID');
    }

    bannedUsers.delete(userId);
    ctx.reply(`User ${userId} unbanned`);
});

bot.command('resetlimit', async (ctx) => {
    if (!isAdmin(ctx.from.username)) return;

    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
        return ctx.reply('Usage: /resetlimit <userId>');
    }

    const userId = parseInt(args[1]);
    if (isNaN(userId)) {
        return ctx.reply('Invalid user ID');
    }

    rateLimiter.delete(userId);
    ctx.reply(`Rate limit reset for ${userId}`);
});

bot.command('activesessions', async (ctx) => {
    if (!isAdmin(ctx.from.username)) return;

    if (activeSessions.size === 0) {
        return ctx.reply('No active sessions');
    }

    let message = `Active Sessions: ${activeSessions.size}\n\n`;
    
    for (const [sessionId, data] of activeSessions) {
        const uptime = formatUptime(Date.now() - data.timestamp);
        message += `ID: ${sessionId}\n`;
        message += `User: ${data.userId}\n`;
        message += `Phone: ${data.phoneNumber}\n`;
        message += `Uptime: ${uptime}\n`;
        message += `GitHub: ${data.savedToGitHub ? 'Yes' : 'No'}\n\n`;
    }

    ctx.reply(message);
});

bot.command('systemstats', async (ctx) => {
    if (!isAdmin(ctx.from.username)) return;

    const mem = process.memoryUsage();
    const uptime = formatUptime(Date.now() - botStartTime);
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const message = `System Stats\n\n` +
        `Uptime: ${uptime}\n` +
        `Platform: ${os.platform()}\n` +
        `Node: ${process.version}\n\n` +
        `Memory:\n` +
        `RSS: ${formatBytes(mem.rss)}\n` +
        `Heap: ${formatBytes(mem.heapUsed)}\n\n` +
        `System:\n` +
        `Total: ${formatBytes(totalMem)}\n` +
        `Used: ${formatBytes(usedMem)}\n` +
        `Free: ${formatBytes(freeMem)}\n\n` +
        `Users: ${userData.size}\n` +
        `Sessions: ${activeSessions.size}\n` +
        `Banned: ${bannedUsers.size}`;

    ctx.reply(message);
});

bot.action('verify_start', async (ctx) => {
    const userId = ctx.from.id;
    
    try {
        await ctx.answerCbQuery('Checking membership...');
    } catch (error) {
        console.log('⚠️ Callback query expired:', error.message);
        return;
    }
    
    const isMember = await isUserInChannel(userId);
    
    if (!isMember) {
        try {
            await ctx.editMessageText(
                'Verification Failed\n\nYou must join our Telegram channel first.',
                Markup.inlineKeyboard([
                    [Markup.button.url('Join Channel', 'https://t.me/firekid_ios')],
                    [Markup.button.callback('Verify Again', 'verify_start')],
                    [Markup.button.callback('Back', 'back_menu')]
                ])
            );
        } catch (e) {
            console.log('⚠️ Message edit failed:', e.message);
        }
        return;
    }
    
    // User is verified - add to persistent storage
    verifiedUsers.add(userId);
    getUserData(userId).verified = true;
    
    try {
        await ctx.editMessageText('✅ Verified! Loading menu...');
        await delay(1500); // Short delay before showing menu
        showMainMenu(ctx);
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
        // Fallback: send new message if edit fails
        try {
            await ctx.reply('✅ Verified!');
            await delay(1000);
            showMainMenu(ctx);
        } catch (err) {
            console.log('⚠️ Fallback message failed:', err.message);
        }
    }
});

bot.action('get_pairing', async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;

    if (isBanned(userId)) {
        try {
            await ctx.answerCbQuery('You are banned');
        } catch (e) {}
        return;
    }

    if (!checkRateLimit(userId, username)) {
        try {
            await ctx.answerCbQuery('Rate limited');
            await ctx.editMessageText(
                `Rate Limit Reached\n\n` +
                `Used: 2/2 codes for today\n` +
                `Reset: 24 hours from first request`,
                Markup.inlineKeyboard([[Markup.button.callback('Back', 'back_menu')]])
            );
        } catch (e) {
            console.log('⚠️ Failed to show rate limit message:', e.message);
        }
        return;
    }

    try {
        await ctx.answerCbQuery('Send phone number');
    } catch (e) {
        console.log('⚠️ Callback query expired:', e.message);
    }
    
    activeRequests.set(userId, { status: 'waiting_number', timestamp: Date.now() });

    try {
        await ctx.editMessageText(
            'Send Phone Number\n\n' +
            'Format: Country code + number (no +)\n\n' +
            'Examples:\n' +
            '• USA: 15551234567\n' +
            '• UK: 447712345678\n' +
            '• Nigeria: 2348123456789\n\n' +
            'Numbers only, no spaces',
            Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'back_menu')]])
        );
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
    }
});

bot.action('disconnect_session', async (ctx) => {
    const userId = ctx.from.id;
    
    if (isBanned(userId)) {
        try {
            await ctx.answerCbQuery('You are banned');
        } catch (e) {}
        return;
    }

    let disconnected = 0;
    const sessionsToRemove = [];

    for (const [sessionId, data] of activeSessions) {
        if (data.userId === userId) {
            try {
                await cleanupSocket(data.socket);
                sessionsToRemove.push(sessionId);
                disconnected++;
            } catch (e) {
                console.error('Disconnect error:', e.message);
            }
        }
    }

    sessionsToRemove.forEach(id => activeSessions.delete(id));

    try {
        await ctx.answerCbQuery('Disconnected');
    } catch (e) {}
    
    try {
        if (disconnected > 0) {
            await ctx.editMessageText(
                `Disconnected ${disconnected} session(s)`,
                Markup.inlineKeyboard([[Markup.button.callback('Back', 'back_menu')]])
            );
        } else {
            await ctx.editMessageText(
                `No active sessions`,
                Markup.inlineKeyboard([[Markup.button.callback('Back', 'back_menu')]])
            );
        }
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
    }
});

bot.action('contact_support', async (ctx) => {
    try {
        await ctx.answerCbQuery('Opening support');
    } catch (e) {}
    
    try {
        await ctx.editMessageText(
            'Contact Support\n\n@unikruzng',
            Markup.inlineKeyboard([
                [Markup.button.url('Contact', 'https://t.me/unikruzng')],
                [Markup.button.callback('Back', 'back_menu')]
            ])
        );
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
    }
});

bot.action('show_help', async (ctx) => {
    try {
        await ctx.answerCbQuery('Loading...');
    } catch (e) {}
    
    try {
        await ctx.editMessageText(
            'Help & Info\n\n' +
            'How to use:\n' +
            '1. Click "Get Code"\n' +
            '2. Send your phone number\n' +
            '3. Wait for code (up to 3 mins)\n' +
            '4. Enter code in WhatsApp\n' +
            '5. Wait for authentication\n\n' +
            'Important:\n' +
            '• 2 codes per 24 hours\n' +
            '• Auto-retry on failures\n' +
            '• If blocked, wait 2-4 hours\n\n' +
            'Created by @firekidffx',
            Markup.inlineKeyboard([[Markup.button.callback('Back', 'back_menu')]])
        );
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
    }
});

bot.action('admin_menu', (ctx) => {
    try {
        ctx.answerCbQuery();
    } catch (e) {}
    showAdminMenu(ctx);
});

bot.action('admin_users', (ctx) => {
    try {
        ctx.answerCbQuery();
    } catch (e) {}
    try {
        ctx.editMessageText(
            `╔════════════════════════╗\n║   USER MANAGEMENT      ║\n╚════════════════════════╝\n\n` +
            `Commands:\n\n/ban <userId>\n/unban <userId>\n/resetlimit <userId>`,
            Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Admin', 'admin_menu')]])
        );
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
    }
});

bot.action('admin_system', (ctx) => {
    try {
        ctx.answerCbQuery();
    } catch (e) {}
    try {
        ctx.editMessageText(
            `╔════════════════════════╗\n║  SYSTEM & SESSIONS     ║\n╚════════════════════════╝\n\n` +
            `Commands:\n\n/activesessions\n/systemstats`,
            Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Admin', 'admin_menu')]])
        );
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
    }
});

bot.action('admin_communication', (ctx) => {
    try {
        ctx.answerCbQuery();
    } catch (e) {}
    try {
        ctx.editMessageText(
            `╔════════════════════════╗\n║    COMMUNICATION       ║\n╚════════════════════════╝\n\n` +
            `Commands:\n\n/broadcast <message>`,
            Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Admin', 'admin_menu')]])
        );
    } catch (e) {
        console.log('⚠️ Message edit failed:', e.message);
    }
});

bot.action('back_main', (ctx) => {
    try {
        ctx.answerCbQuery();
    } catch (e) {}
    if (isAdmin(ctx.from.username)) {
        showAdminMenu(ctx);
    } else {
        showMainMenu(ctx);
    }
});

bot.action('back_menu', (ctx) => {
    try {
        ctx.answerCbQuery();
    } catch (e) {}
    activeRequests.delete(ctx.from.id);
    if (isAdmin(ctx.from.username)) {
        showAdminMenu(ctx);
    } else {
        showMainMenu(ctx);
    }
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const username = ctx.from.username;
    
    if (isBanned(userId)) {
        return;
    }

    if (!isUserVerified(userId, username) && !isAdmin(username)) return;

    const activeRequest = activeRequests.get(userId);
    if (!activeRequest) return;
    
    if (activeRequest.status !== 'waiting_number' && activeRequest.status !== 'admin_waiting_number') return;

    const isAdminRequest = activeRequest.status === 'admin_waiting_number';
    const phoneNumber = formatPhoneNumber(ctx.message.text);
    
    if (!phoneNumber) {
        return ctx.reply(
            'Invalid phone number\n\n' +
            'Example: 2348123456789\n' +
            '(No spaces, no +, just numbers)',
            Markup.inlineKeyboard([[Markup.button.callback('Cancel', isAdminRequest ? 'admin_menu' : 'back_menu')]])
        );
    }

    activeRequests.set(userId, { status: 'generating', timestamp: Date.now() });

    const loadingMsg = await ctx.reply(
        `${isAdminRequest ? '🔐 ADMIN ' : ''}Connecting to WhatsApp...\n\n` +
        'This may take 1-3 minutes\n' +
        'Keep your phone ready\n\n' +
        'Please be patient...'
    );

    const timeoutTimer = setTimeout(async () => {
        const currentRequest = activeRequests.get(userId);
        if (currentRequest && currentRequest.status === 'generating') {
            activeRequests.delete(userId);
            
            try {
                await ctx.telegram.editMessageText(
                    ctx.chat.id, loadingMsg.message_id, null,
                    `Request Timeout\n\n` +
                    `Phone: +${phoneNumber}\n\n` +
                    `The pairing process took too long and was cancelled.\n\n` +
                    `Please try again.`,
                    Markup.inlineKeyboard([[Markup.button.callback('Back', isAdminRequest ? 'admin_menu' : 'back_menu')]])
                );
            } catch (e) {
                console.error('Timeout message error:', e.message);
            }
        }
    }, REQUEST_TIMEOUT);

    try {
        const result = await generatePairingCode(phoneNumber, userId);

        clearTimeout(timeoutTimer);

        getUserData(userId).pairHistory.push({
            phoneNumber, code: result.code, timestamp: Date.now(), success: true, admin: isAdminRequest
        });

        await ctx.telegram.editMessageText(
            ctx.chat.id, loadingMsg.message_id, null,
            `${isAdminRequest ? '🔐 ADMIN ' : ''}Pairing Code Generated\n\n` +
            `Phone: +${phoneNumber}\n` +
            `Code: \`${result.code}\`\n\n` +
            `Next Steps:\n` +
            `1. Open WhatsApp\n` +
            `2. Go to: Settings > Linked Devices\n` +
            `3. Tap "Link a Device"\n` +
            `4. Enter the code above\n\n` +
            `Code expires in 10 minutes\n` +
            `Bot will auto-connect after pairing`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        clearTimeout(timeoutTimer);
        console.error('Pairing error:', error.message);

        getUserData(userId).pairHistory.push({
            phoneNumber, timestamp: Date.now(), success: false, error: error.message
        });

        await ctx.telegram.editMessageText(
            ctx.chat.id, loadingMsg.message_id, null,
            `Pairing Failed\n\n` +
            `Phone: +${phoneNumber}\n` +
            `Error: ${error.message}\n\n` +
            `Solutions:\n` +
            `• Wait 2-4 hours and retry\n` +
            `• Try different number\n` +
            `• Check internet connection\n\n` +
            `WhatsApp may be blocking automated requests.`,
            Markup.inlineKeyboard([[Markup.button.callback('Back', isAdminRequest ? 'admin_menu' : 'back_menu')]])
        );
    } finally {
        activeRequests.delete(userId);
    }
});

bot.catch((err) => {
    console.error('Bot error:', err.message);
});

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Firekid Bot is running\n');
});

async function startBot() {
    try {
        if (!process.env.TELEGRAM_BOT_TOKEN) {
            throw new Error('TELEGRAM_BOT_TOKEN is required');
        }

        if (!process.env.GITHUB_TOKEN) {
            throw new Error('GITHUB_TOKEN is required');
        }

        if (!process.env.GITHUB_REPO_URL) {
            throw new Error('GITHUB_REPO_URL is required');
        }

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`🌐 Server running on port ${PORT}`);
        });

        console.log('🔄 Starting self-ping and cleanup...');
        selfPing();
        startCleanupScheduler();
        console.log('✅ Self-ping and cleanup started');

        await bot.launch();
        console.log('✅ Bot started successfully');
        console.log('📱 Using Baileys with macOS Chrome browser');
        console.log('🔧 Using makeCacheableSignalKeyStore for keys');
        console.log('⏱️ Rate limits: 2 codes/24h');
        console.log('🔄 Max retries: 2');
        console.log('⏰ Timeout: 3 minutes');
        console.log('🧹 Cleanup interval: 3 minutes');

        process.once('SIGINT', () => {
            server.close();
            bot.stop('SIGINT');
        });
        process.once('SIGTERM', () => {
            server.close();
            bot.stop('SIGTERM');
        });

    } catch (error) {
        console.error('Failed to start:', error.message);
        process.exit(1);
    }
}

if (require.main === module) {
    startBot();
}

module.exports = { bot, startBot, gitHubStorage };
