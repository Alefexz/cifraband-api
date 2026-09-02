// ============================================================
// CIFRA BAND API
// Busca inteligente e robusta de cifras no Cifra Club
// ============================================================

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// FIX: sem isso, qualquer chamada vinda de um app Flutter Web (ou de
// qualquer origem diferente do próprio servidor) falha por CORS antes
// de chegar no endpoint.
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    res.header(
        'Access-Control-Allow-Headers',
        'Authorization,Content-Type'
    );
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

const port = process.env.PORT || 3000;

const CIFRA_BASE = 'https://www.cifraclub.com.br';

const CACHE_TTL = 12 * 60 * 60 * 1000;       // 12 horas
const CATALOG_TTL = 6 * 60 * 60 * 1000;      // 6 horas
const MAX_CACHE_ITEMS = 500;

const REQUEST_TIMEOUT = 9000;

const DIRECT_CONCURRENCY = 6;
const CATALOG_CONCURRENCY = 5;
const SEARCH_CONCURRENCY = 5;
const WEB_SEARCH_CONCURRENCY = 4;
const WEB_QUERY_CONCURRENCY = 3;
const CIFRACLUB_WEB_QUERY_LIMIT = 5;
const ALTERNATIVE_WEB_QUERY_LIMIT = 8;

const NOTIFICATION_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const NOTIFICATION_RATE_LIMIT_MAX = 30;
const SEARCH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SEARCH_RATE_LIMIT_MAX = 60;
const FEEDBACK_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const FEEDBACK_RATE_LIMIT_MAX = 8;
const SUPPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SUPPORT_RATE_LIMIT_MAX = 60;
const rateLimitBuckets = new Map();

const BUNDLED_APP_VERSION = '1.3.0';
const BUNDLED_APP_BUILD = 15;
const BUNDLED_APK_URL =
    'https://github.com/Alefexz/cifra_band/raw/main/releases/cifra-band-1.3.0-build-15.apk';
const BUNDLED_RELEASE_NOTES =
    'Atualização 1.3.0 disponível com biblioteca oficial, importação de cifras, ensaio, exportação e ferramentas musicais.';
const FEEDBACK_TYPES =
    new Set(['bug', 'wrong_chord', 'notification', 'update', 'question', 'suggestion']);
const FEEDBACK_SEVERITIES =
    new Set(['critical', 'high', 'medium', 'low']);
const SUPPORT_TICKET_STATUSES =
    new Set(['open', 'resolved', 'closed']);
const SUPPORT_OWNER_EMAILS =
    new Set(
        String(
            process.env.SUPPORT_OWNER_EMAILS ||
            'niotico2006@gmail.com,niotio2006@gmail.com'
        )
            .split(',')
            .map(email => email.trim().toLowerCase())
            .filter(Boolean)
    );

// ============================================================
// CACHE
// ============================================================
// ATENÇÃO: isso é memória do processo. No Render free tier o servidor
// derruba depois de ~15min sem tráfego e sobe zerado — ou seja, esse
// cache (e o aprendizado de aliases) não sobrevive entre "sonos" do
// serviço. Funciona bem enquanto o processo está de pé, mas não é
// persistente de verdade. Se quiser resolver isso direito, dá pra
// trocar por um banco externo (Firestore funciona normal fora do
// Firebase Functions, só precisa de uma service account).

const songCache = new Map();
const catalogCache = new Map();
const inFlight = new Map();

// ============================================================
// USER AGENT
// ============================================================

const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

    'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,' +
        'image/avif,image/webp,image/apng,*/*;q=0.8',

    'Accept-Language':
        'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',

    'Cache-Control': 'no-cache',

    'Pragma': 'no-cache'
};

// ============================================================
// ROOT
// ============================================================

app.get('/', (req, res) => {
    res.status(200).json({
        status: 'online',
        service: 'Cifra Band API',
        version: 'V5-Intelligent',
        timestamp: new Date().toISOString()
    });
});

function parseBooleanEnv(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    return ['1', 'true', 'yes', 'sim'].includes(
        String(value).trim().toLowerCase()
    );
}

function parseIntegerEnv(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function getAppVersionPayload() {
    const configuredBuild =
        parseIntegerEnv(process.env.APP_LATEST_BUILD, BUNDLED_APP_BUILD);
    const latestBuild =
        Math.max(configuredBuild, BUNDLED_APP_BUILD);
    const useBundledVersion =
        latestBuild === BUNDLED_APP_BUILD &&
        configuredBuild < BUNDLED_APP_BUILD;
    const configuredApkUrl = process.env.APP_APK_URL || '';
    const useBundledApk =
        latestBuild === BUNDLED_APP_BUILD &&
        (
            configuredApkUrl === '' ||
            configuredApkUrl.includes('/releases/latest')
        );

    return {
        latestVersion: useBundledVersion
            ? BUNDLED_APP_VERSION
            : process.env.APP_LATEST_VERSION || BUNDLED_APP_VERSION,
        latestBuild,
        minimumBuild:
            parseIntegerEnv(process.env.APP_MINIMUM_BUILD, 1),
        updateRequired:
            parseBooleanEnv(process.env.APP_UPDATE_REQUIRED, false),
        apkUrl: useBundledApk ? BUNDLED_APK_URL : configuredApkUrl,
        releaseNotes: useBundledVersion
            ? BUNDLED_RELEASE_NOTES
            : process.env.APP_RELEASE_NOTES || BUNDLED_RELEASE_NOTES,
        checkedAt: new Date().toISOString()
    };
}

app.get(
    '/app-version',
    rateLimit({
        name: 'appVersion',
        windowMs: 10 * 60 * 1000,
        max: 120
    }),
    (req, res) => {
        res.status(200).json(getAppVersionPayload());
    }
);

// ============================================================
// FIREBASE ADMIN / PUSH
// ============================================================

let firebaseAdminInitError = null;

function getFirebaseAdmin() {
    if (admin.apps.length) {
        return admin;
    }

    try {
        const rawServiceAccount =
            process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
            process.env.FIREBASE_SERVICE_ACCOUNT;

        if (rawServiceAccount) {
            const serviceAccount =
                JSON.parse(rawServiceAccount);

            if (serviceAccount.private_key) {
                serviceAccount.private_key =
                    serviceAccount.private_key.replace(/\\n/g, '\n');
            }

            admin.initializeApp({
                credential:
                    admin.credential.cert(
                        serviceAccount
                    )
            });
        } else {
            admin.initializeApp({
                credential:
                    admin.credential.applicationDefault()
            });
        }

        firebaseAdminInitError = null;
        return admin;
    } catch (error) {
        firebaseAdminInitError = error;
        console.error(
            'Falha ao inicializar Firebase Admin:',
            error.message
        );
        return null;
    }
}

async function authenticateFirebaseUser(req, res, next) {
    const authHeader =
        req.headers.authorization || '';

    const match =
        String(authHeader).match(/^Bearer\s+(.+)$/i);

    if (!match) {
        return res.status(401).json({
            error: 'missing_auth_token',
            message: 'Envie o ID token do Firebase no header Authorization.'
        });
    }

    const firebaseAdmin = getFirebaseAdmin();

    if (!firebaseAdmin) {
        return res.status(503).json({
            error: 'firebase_admin_unavailable',
            message:
                'Firebase Admin não foi inicializado no servidor.',
            detail:
                firebaseAdminInitError?.message ||
                'Credencial ausente ou inválida.'
        });
    }

    try {
        req.firebaseUser =
            await firebaseAdmin
                .auth()
                .verifyIdToken(match[1]);

        return next();
    } catch (error) {
        return res.status(401).json({
            error: 'invalid_auth_token',
            message: 'ID token do Firebase inválido ou expirado.'
        });
    }
}

function clientIdentity(req) {
    const uid = req.firebaseUser?.uid;
    if (uid) return `uid:${uid}`;

    const forwardedFor =
        String(req.headers['x-forwarded-for'] || '')
            .split(',')[0]
            .trim();

    return `ip:${forwardedFor || req.ip || 'unknown'}`;
}

function rateLimit({ name, windowMs, max }) {
    return (req, res, next) => {
        const now = Date.now();
        const key = `${name}:${clientIdentity(req)}`;
        const bucket =
            rateLimitBuckets.get(key) || {
                count: 0,
                resetAt: now + windowMs
            };

        if (now > bucket.resetAt) {
            bucket.count = 0;
            bucket.resetAt = now + windowMs;
        }

        bucket.count += 1;
        rateLimitBuckets.set(key, bucket);

        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader(
            'X-RateLimit-Remaining',
            String(Math.max(0, max - bucket.count))
        );
        res.setHeader(
            'X-RateLimit-Reset',
            String(Math.ceil(bucket.resetAt / 1000))
        );

        if (bucket.count > max) {
            return res.status(429).json({
                error: 'rate_limit_exceeded',
                message:
                    'Muitas requisições em pouco tempo. Tente novamente em alguns minutos.'
            });
        }

        return next();
    };
}

async function assertNotificationTargetsInSameChurch(req, res, next) {
    const firebaseAdmin = getFirebaseAdmin();
    if (!firebaseAdmin) {
        return res.status(503).json({
            error: 'firebase_admin_unavailable',
            message: 'Firebase Admin não foi inicializado no servidor.'
        });
    }

    try {
        const firestore = firebaseAdmin.firestore();
        const senderUid = req.firebaseUser.uid;
        const senderDoc =
            await firestore.collection('users').doc(senderUid).get();
        const senderChurchId =
            String(senderDoc.data()?.church_id || '').trim();
        const senderData =
            senderDoc.data() || {};

        if (!senderDoc.exists || !senderChurchId) {
            return res.status(403).json({
                error: 'sender_without_church',
                message: 'Usuário remetente não pertence a um ministério.'
            });
        }

        const requestedUserIds = Array.isArray(req.body?.userIds)
            ? req.body.userIds
            : [];
        const targetUserIds =
            [...new Set(
                requestedUserIds
                    .map(uid => String(uid || '').trim())
                    .filter(Boolean)
            )].slice(0, 100);

        const targetDocs =
            await Promise.all(
                targetUserIds.map(uid =>
                    firestore.collection('users').doc(uid).get()
                )
            );

        const forbiddenTargets = [];
        for (let index = 0; index < targetDocs.length; index++) {
            const targetDoc = targetDocs[index];
            const targetChurchId =
                String(targetDoc.data()?.church_id || '').trim();

            if (
                !targetDoc.exists ||
                targetChurchId !== senderChurchId
            ) {
                forbiddenTargets.push(targetUserIds[index]);
            }
        }

        if (forbiddenTargets.length) {
            return res.status(403).json({
                error: 'forbidden_notification_targets',
                message:
                    'Push bloqueado: todos os destinatários precisam pertencer ao mesmo ministério do remetente.',
                rejectedTargets: forbiddenTargets.length
            });
        }

        req.notificationTargetUserIds = targetUserIds;
        req.notificationSender = {
            uid: senderUid,
            churchId: senderChurchId,
            isAdmin: senderData.is_admin === true
        };
        req.notificationTargets =
            targetDocs.map((targetDoc, index) => ({
                uid: targetUserIds[index],
                exists: targetDoc.exists,
                churchId: String(targetDoc.data()?.church_id || '').trim(),
                isAdmin: targetDoc.data()?.is_admin === true
            }));
        return next();
    } catch (error) {
        return res.status(500).json({
            error: 'notification_authorization_failed',
            message: 'Falha ao validar destinatários da notificação.'
        });
    }
}

function notificationAction(req) {
    const data =
        normalizeNotificationData(req.body?.data);

    return {
        type: String(data.type || '').trim(),
        scheduleId: String(data.scheduleId || '').trim()
    };
}

async function getScheduleForNotification(req, scheduleId) {
    if (!scheduleId) return null;

    const firebaseAdmin = getFirebaseAdmin();
    if (!firebaseAdmin) return null;

    const doc =
        await firebaseAdmin
            .firestore()
            .collection('schedules')
            .doc(scheduleId)
            .get();

    if (!doc.exists) return null;

    const data = doc.data() || {};
    const churchId = String(data.church_id || '').trim();

    if (churchId !== req.notificationSender?.churchId) {
        return null;
    }

    return data;
}

function scheduleTeamUids(schedule) {
    const result = new Set(
        Array.isArray(schedule.team_uids)
            ? schedule.team_uids.map(uid => String(uid || '').trim())
            : []
    );

    if (Array.isArray(schedule.team_assignments)) {
        for (const item of schedule.team_assignments) {
            const uid = String(item?.uid || '').trim();
            if (uid) result.add(uid);
        }
    }

    return result;
}

function senderIsOnSchedule(req, schedule) {
    return scheduleTeamUids(schedule).has(req.notificationSender?.uid);
}

function allTargetsAreAdmins(req) {
    return (req.notificationTargets || []).every(target => target.isAdmin);
}

function allTargetsAreScheduleTeamOrAdmins(req, schedule) {
    const teamUids = scheduleTeamUids(schedule);

    return (req.notificationTargets || []).every(
        target => target.isAdmin || teamUids.has(target.uid)
    );
}

async function authorizeNotificationAction(req, res, next) {
    const sender = req.notificationSender;

    if (!sender) {
        return res.status(403).json({
            error: 'notification_sender_not_checked',
            message: 'Remetente da notificação não foi validado.'
        });
    }

    if (sender.isAdmin) {
        return next();
    }

    const action = notificationAction(req);

    if (action.type === 'new_member') {
        if (allTargetsAreAdmins(req)) return next();
    }

    if (
        action.type === 'assignment_response' ||
        action.type === 'song_suggestion'
    ) {
        const schedule =
            await getScheduleForNotification(req, action.scheduleId);

        if (!schedule || !senderIsOnSchedule(req, schedule)) {
            return res.status(403).json({
                error: 'forbidden_notification_action',
                message:
                    'Push bloqueado: esta ação precisa estar ligada a uma escala onde o remetente participa.'
            });
        }

        if (
            action.type === 'assignment_response' &&
            allTargetsAreAdmins(req)
        ) {
            return next();
        }

        if (
            action.type === 'song_suggestion' &&
            allTargetsAreScheduleTeamOrAdmins(req, schedule)
        ) {
            return next();
        }
    }

    return res.status(403).json({
        error: 'forbidden_notification_action',
        message:
            'Push bloqueado: usuário comum só pode avisar ações permitidas da própria escala.'
    });
}

function normalizeNotificationData(data) {
    const result = {};

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return result;
    }

    for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined) {
            continue;
        }

        result[String(key)] = String(value);
    }

    return result;
}

async function sendSystemNotificationToUsers(
    firebaseAdmin,
    firestore,
    userIds,
    {
        title,
        body,
        data
    }
) {
    const targetUserIds =
        [...new Set(
            (Array.isArray(userIds) ? userIds : [])
                .map(uid => String(uid || '').trim())
                .filter(Boolean)
        )].slice(0, 100);

    if (!targetUserIds.length) {
        return {
            requestedUsers: 0,
            targetTokens: 0,
            sent: 0,
            failed: 0
        };
    }

    const userDocs =
        await Promise.all(
            targetUserIds.map(uid =>
                firestore
                    .collection('users')
                    .doc(uid)
                    .get()
            )
        );

    const tokenToUserIds =
        new Map();

    for (let index = 0; index < userDocs.length; index++) {
        const userDoc = userDocs[index];
        if (!userDoc.exists) continue;

        const userData =
            userDoc.data() || {};
        const tokens = [];

        if (Array.isArray(userData.fcmTokens)) {
            tokens.push(...userData.fcmTokens);
        }

        if (typeof userData.fcmToken === 'string') {
            tokens.push(userData.fcmToken);
        }

        for (const token of tokens) {
            const cleanToken =
                String(token || '').trim();
            if (!cleanToken) continue;

            const owners =
                tokenToUserIds.get(cleanToken) || [];
            owners.push(targetUserIds[index]);
            tokenToUserIds.set(cleanToken, owners);
        }
    }

    const tokens =
        [...tokenToUserIds.keys()].slice(0, 500);

    if (!tokens.length) {
        return {
            requestedUsers: targetUserIds.length,
            targetTokens: 0,
            sent: 0,
            failed: 0
        };
    }

    const response =
        await firebaseAdmin
            .messaging()
            .sendEachForMulticast({
                tokens,
                notification: {
                    title: String(title || '').trim().slice(0, 80),
                    body: String(body || '').trim().slice(0, 180)
                },
                data:
                    normalizeNotificationData(data),
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'cifra_band_alerts'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            sound: 'default'
                        }
                    }
                }
            });

    const invalidTokens = [];

    response.responses.forEach((item, index) => {
        const code =
            item.error?.code;

        if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered'
        ) {
            invalidTokens.push(tokens[index]);
        }
    });

    if (invalidTokens.length) {
        const cleanupPromises = [];

        for (const invalidToken of invalidTokens) {
            const owners =
                tokenToUserIds.get(invalidToken) || [];

            for (const uid of owners) {
                cleanupPromises.push(
                    firestore
                        .collection('users')
                        .doc(uid)
                        .set({
                            fcmTokens:
                                firebaseAdmin.firestore.FieldValue.arrayRemove(
                                    invalidToken
                                )
                        }, { merge: true })
                );
            }
        }

        await Promise.allSettled(cleanupPromises);
    }

    return {
        requestedUsers: targetUserIds.length,
        targetTokens: tokens.length,
        sent: response.successCount,
        failed: response.failureCount
    };
}

function sanitizeSupportValue(value, depth = 0) {
    if (depth > 3 || value === undefined) {
        return null;
    }

    if (value === null || typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
        return value.trim().slice(0, 500);
    }

    if (Array.isArray(value)) {
        return value
            .slice(0, 20)
            .map(item => sanitizeSupportValue(item, depth + 1));
    }

    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .slice(0, 40)
                .map(([key, item]) => [
                    String(key).slice(0, 80),
                    sanitizeSupportValue(item, depth + 1)
                ])
        );
    }

    return String(value).slice(0, 500);
}

function sanitizeSupportObject(value) {
    const sanitized =
        sanitizeSupportValue(value);

    if (
        sanitized &&
        typeof sanitized === 'object' &&
        !Array.isArray(sanitized)
    ) {
        return sanitized;
    }

    return {};
}

function sanitizeSupportLogs(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .slice(-80)
        .map(item => sanitizeSupportObject(item))
        .filter(item => Object.keys(item).length > 0);
}

function supportMessage({
    sender,
    message,
    name,
    uid,
    kind = 'message'
}) {
    return {
        sender:
            String(sender || 'system').slice(0, 30),
        kind:
            String(kind || 'message').slice(0, 40),
        message:
            String(message || '').trim().slice(0, 1200),
        name:
            String(name || '').trim().slice(0, 120) || null,
        uid:
            String(uid || '').trim().slice(0, 120) || null,
        created_at:
            new Date().toISOString()
    };
}

async function supportRecipientsForTicket(firestore, ticketUser) {
    const recipients = new Set();
    const churchId =
        String(ticketUser?.church_id || '').trim();

    if (churchId) {
        const adminsSnapshot =
            await firestore
                .collection('users')
                .where('church_id', '==', churchId)
                .limit(80)
                .get();

        adminsSnapshot.docs.forEach(doc => {
            const userData =
                doc.data() || {};

            if (doc.id !== ticketUser.uid && userData.is_admin === true) {
                recipients.add(doc.id);
            }
        });
    }

    for (const email of SUPPORT_OWNER_EMAILS) {
        try {
            const ownerSnapshot =
                await firestore
                    .collection('users')
                    .where('email', '==', email)
                    .limit(5)
                    .get();

            ownerSnapshot.docs.forEach(doc => recipients.add(doc.id));
        } catch (error) {
            console.error(
                'Falha ao buscar suporte global por email:',
                error.message
            );
        }
    }

    return [...recipients];
}

function serializeSupportValue(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value?.toDate === 'function') {
        return value.toDate().toISOString();
    }

    if (Array.isArray(value)) {
        return value.map(serializeSupportValue);
    }

    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                serializeSupportValue(item)
            ])
        );
    }

    return value;
}

async function loadSupportAdmin(req, res, next) {
    const firebaseAdmin = getFirebaseAdmin();

    if (!firebaseAdmin) {
        return res.status(503).json({
            error: 'firebase_admin_unavailable',
            message: 'Firebase Admin não foi inicializado no servidor.'
        });
    }

    try {
        const userDoc =
            await firebaseAdmin
                .firestore()
                .collection('users')
                .doc(req.firebaseUser.uid)
                .get();
        const userData =
            userDoc.data() || {};
        const churchId =
            String(userData.church_id || '').trim();
        const email =
            String(req.firebaseUser.email || userData.email || '')
                .trim()
                .toLowerCase();
        const isGlobalSupportOwner =
            SUPPORT_OWNER_EMAILS.has(email);

        if (
            !isGlobalSupportOwner &&
            (!userDoc.exists || userData.is_admin !== true || !churchId)
        ) {
            return res.status(403).json({
                error: 'support_admin_required',
                message:
                    'Apenas administradores de ministério podem acessar a central de suporte.'
            });
        }

        req.supportAdmin = {
            uid: req.firebaseUser.uid,
            churchId,
            isGlobal: isGlobalSupportOwner
        };
        return next();
    } catch (error) {
        console.error('Falha ao validar admin de suporte:', error);
        return res.status(500).json({
            error: 'support_admin_validation_failed',
            message: 'Não consegui validar sua permissão de suporte.'
        });
    }
}

app.get(
    '/support-tickets',
    authenticateFirebaseUser,
    rateLimit({
        name: 'supportTickets',
        windowMs: SUPPORT_RATE_LIMIT_WINDOW_MS,
        max: SUPPORT_RATE_LIMIT_MAX
    }),
    loadSupportAdmin,
    async (req, res) => {
        const firebaseAdmin = getFirebaseAdmin();
        const status =
            String(req.query.status || 'open').trim();
        const type =
            String(req.query.type || 'all').trim();
        const severity =
            String(req.query.severity || 'all').trim();
        const limit =
            Math.min(
                Math.max(parseIntegerEnv(req.query.limit, 50), 1),
                100
            );

        if (status !== 'all' && !SUPPORT_TICKET_STATUSES.has(status)) {
            return res.status(400).json({
                error: 'invalid_support_ticket_status',
                message: 'Status de ticket inválido.'
            });
        }

        if (type !== 'all' && !FEEDBACK_TYPES.has(type)) {
            return res.status(400).json({
                error: 'invalid_feedback_type',
                message: 'Tipo de feedback inválido.'
            });
        }

        if (severity !== 'all' && !FEEDBACK_SEVERITIES.has(severity)) {
            return res.status(400).json({
                error: 'invalid_feedback_severity',
                message: 'Prioridade de feedback inválida.'
            });
        }

        try {
            let query =
                firebaseAdmin
                    .firestore()
                    .collection('support_tickets');

            if (!req.supportAdmin.isGlobal) {
                query =
                    query.where(
                        'user.church_id',
                        '==',
                        req.supportAdmin.churchId
                    );
            }

            const snapshot =
                await query.limit(limit).get();

            const tickets =
                snapshot.docs
                    .map(doc => ({
                        id: doc.id,
                        ...serializeSupportValue(doc.data())
                    }))
                    .filter(ticket =>
                        status === 'all' || ticket.status === status
                    )
                    .filter(ticket =>
                        type === 'all' || ticket.type === type
                    )
                    .filter(ticket =>
                        severity === 'all' || ticket.severity === severity
                    )
                    .sort((a, b) =>
                        String(b.created_at || '').localeCompare(
                            String(a.created_at || '')
                        )
                    );

            return res.status(200).json({
                tickets,
                count: tickets.length
            });
        } catch (error) {
            console.error('Falha ao listar tickets:', error);
            return res.status(500).json({
                error: 'support_tickets_list_failed',
                message: 'Não consegui carregar os feedbacks agora.'
            });
        }
    }
);

app.get(
    '/my-support-tickets',
    authenticateFirebaseUser,
    rateLimit({
        name: 'mySupportTickets',
        windowMs: SUPPORT_RATE_LIMIT_WINDOW_MS,
        max: SUPPORT_RATE_LIMIT_MAX
    }),
    async (req, res) => {
        const firebaseAdmin = getFirebaseAdmin();

        if (!firebaseAdmin) {
            return res.status(503).json({
                error: 'firebase_admin_unavailable',
                message: 'Firebase Admin não foi inicializado no servidor.'
            });
        }

        try {
            const snapshot =
                await firebaseAdmin
                    .firestore()
                    .collection('support_tickets')
                    .where('user.uid', '==', req.firebaseUser.uid)
                    .limit(50)
                    .get();

            const tickets =
                snapshot.docs
                    .map(doc => ({
                        id: doc.id,
                        ...serializeSupportValue(doc.data())
                    }))
                    .sort((a, b) =>
                        String(b.created_at || '').localeCompare(
                            String(a.created_at || '')
                        )
                    );

            const hasPendingReply =
                tickets.some(ticket =>
                    ticket.status === 'open' &&
                    !String(ticket.admin_reply?.message || '').trim()
                );

            return res.status(200).json({
                tickets,
                count: tickets.length,
                canCreateNew: !hasPendingReply
            });
        } catch (error) {
            console.error('Falha ao listar meus tickets:', error);
            return res.status(500).json({
                error: 'my_support_tickets_list_failed',
                message: 'Não consegui carregar seus feedbacks agora.'
            });
        }
    }
);

app.patch(
    '/my-support-tickets/:ticketId',
    authenticateFirebaseUser,
    rateLimit({
        name: 'mySupportTicketUpdate',
        windowMs: SUPPORT_RATE_LIMIT_WINDOW_MS,
        max: SUPPORT_RATE_LIMIT_MAX
    }),
    async (req, res) => {
        const firebaseAdmin = getFirebaseAdmin();
        const ticketId =
            String(req.params.ticketId || '').trim();
        const status =
            String(req.body?.status || '').trim();

        if (!ticketId) {
            return res.status(400).json({
                error: 'missing_ticket_id',
                message: 'Informe o ticket.'
            });
        }

        if (!['open', 'resolved', 'closed'].includes(status)) {
            return res.status(400).json({
                error: 'invalid_support_ticket_status',
                message: 'Status de ticket inválido.'
            });
        }

        if (!firebaseAdmin) {
            return res.status(503).json({
                error: 'firebase_admin_unavailable',
                message: 'Firebase Admin não foi inicializado no servidor.'
            });
        }

        try {
            const firestore =
                firebaseAdmin.firestore();
            const ticketRef =
                firestore
                    .collection('support_tickets')
                    .doc(ticketId);
            const ticketDoc =
                await ticketRef.get();

            if (!ticketDoc.exists) {
                return res.status(404).json({
                    error: 'support_ticket_not_found',
                    message: 'Feedback não encontrado.'
                });
            }

            const ticket =
                ticketDoc.data() || {};
            const ownerUid =
                String(ticket.user?.uid || '').trim();

            if (ownerUid !== req.firebaseUser.uid) {
                return res.status(403).json({
                    error: 'support_ticket_forbidden',
                    message: 'Você só pode alterar seus próprios feedbacks.'
                });
            }

            const userName =
                ticket.user?.name ||
                req.firebaseUser.name ||
                req.firebaseUser.email ||
                'Usuário';

            await ticketRef.update({
                status,
                updated_at:
                    admin.firestore.FieldValue.serverTimestamp(),
                user_status_updated_at:
                    admin.firestore.FieldValue.serverTimestamp(),
                messages:
                    admin.firestore.FieldValue.arrayUnion(
                        supportMessage({
                            sender: 'user',
                            kind: `user_status_${status}`,
                            message:
                                status === 'open'
                                    ? 'Ainda preciso de ajuda.'
                                    : 'Problema marcado como resolvido pelo usuário.',
                            uid: req.firebaseUser.uid,
                            name: userName
                        })
                    )
            });

            return res.status(200).json({
                success: true,
                ticketId,
                status
            });
        } catch (error) {
            console.error('Falha ao atualizar meu ticket:', error);
            return res.status(500).json({
                error: 'my_support_ticket_update_failed',
                message: 'Não consegui atualizar seu feedback agora.'
            });
        }
    }
);

app.patch(
    '/support-tickets/:ticketId',
    authenticateFirebaseUser,
    rateLimit({
        name: 'supportTicketUpdate',
        windowMs: SUPPORT_RATE_LIMIT_WINDOW_MS,
        max: SUPPORT_RATE_LIMIT_MAX
    }),
    loadSupportAdmin,
    async (req, res) => {
        const firebaseAdmin = getFirebaseAdmin();
        const ticketId =
            String(req.params.ticketId || '').trim();
        const status =
            String(req.body?.status || '').trim();
        const reply =
            String(req.body?.reply || '').trim().slice(0, 1200);

        if (!ticketId) {
            return res.status(400).json({
                error: 'missing_ticket_id',
                message: 'Informe o ticket.'
            });
        }

        if (!SUPPORT_TICKET_STATUSES.has(status)) {
            return res.status(400).json({
                error: 'invalid_support_ticket_status',
                message: 'Status de ticket inválido.'
            });
        }

        try {
            const firestore =
                firebaseAdmin.firestore();
            const ticketRef =
                firestore
                    .collection('support_tickets')
                    .doc(ticketId);
            const ticketDoc =
                await ticketRef.get();

            if (!ticketDoc.exists) {
                return res.status(404).json({
                    error: 'support_ticket_not_found',
                    message: 'Feedback não encontrado.'
                });
            }

            const ticket =
                ticketDoc.data() || {};
            const ticketChurchId =
                String(ticket.user?.church_id || '').trim();

            if (
                !req.supportAdmin.isGlobal &&
                ticketChurchId !== req.supportAdmin.churchId
            ) {
                return res.status(403).json({
                    error: 'support_ticket_forbidden',
                    message:
                        'Você só pode alterar feedbacks do seu ministério.'
                });
            }

            const updatePayload = {
                status,
                updated_at: admin.firestore.FieldValue.serverTimestamp(),
                handled_by: {
                    uid: req.supportAdmin.uid,
                    at: admin.firestore.FieldValue.serverTimestamp()
                }
            };

            if (reply) {
                updatePayload.admin_reply = {
                    message: reply,
                    responder_uid: req.supportAdmin.uid,
                    responder_name:
                        req.firebaseUser.name ||
                        req.firebaseUser.email ||
                        'Suporte Cifra Band',
                    created_at: admin.firestore.FieldValue.serverTimestamp()
                };
                updatePayload.messages =
                    admin.firestore.FieldValue.arrayUnion(
                        supportMessage({
                            sender: 'admin',
                            kind: 'admin_reply',
                            message: reply,
                            uid: req.supportAdmin.uid,
                            name:
                                req.firebaseUser.name ||
                                req.firebaseUser.email ||
                                'Suporte Cifra Band'
                        })
                    );
            } else if (status !== ticket.status) {
                updatePayload.messages =
                    admin.firestore.FieldValue.arrayUnion(
                        supportMessage({
                            sender: 'admin',
                            kind: `status_${status}`,
                            message:
                                `Chamado marcado como ${status}.`,
                            uid: req.supportAdmin.uid,
                            name:
                                req.firebaseUser.name ||
                                req.firebaseUser.email ||
                                'Suporte Cifra Band'
                        })
                    );
            }

            await ticketRef.update(updatePayload);

            let notificationResult = null;

            if (reply) {
                const ticketOwnerUid =
                    String(ticket.user?.uid || '').trim();

                if (ticketOwnerUid) {
                    try {
                        notificationResult =
                            await sendSystemNotificationToUsers(
                                firebaseAdmin,
                                firestore,
                                [ticketOwnerUid],
                                {
                                    title: 'Suporte respondeu',
                                    body:
                                        reply.length > 120
                                            ? `${reply.slice(0, 117)}...`
                                            : reply,
                                    data: {
                                        type: 'support_reply',
                                        ticketId,
                                        status
                                    }
                                }
                            );
                    } catch (notificationError) {
                        console.error(
                            'Falha ao notificar resposta do suporte:',
                            notificationError.message
                        );
                    }
                }
            }

            return res.status(200).json({
                success: true,
                ticketId,
                status,
                replied: Boolean(reply),
                notification: notificationResult
            });
        } catch (error) {
            console.error('Falha ao atualizar ticket:', error);
            return res.status(500).json({
                error: 'support_ticket_update_failed',
                message: 'Não consegui atualizar o feedback agora.'
            });
        }
    }
);

app.post(
    '/feedback',
    authenticateFirebaseUser,
    rateLimit({
        name: 'feedback',
        windowMs: FEEDBACK_RATE_LIMIT_WINDOW_MS,
        max: FEEDBACK_RATE_LIMIT_MAX
    }),
    async (req, res) => {
        const body = req.body || {};
        const type =
            String(body.type || '').trim();
        const severity =
            String(body.severity || '').trim();
        const message =
            String(body.message || '').trim();
        const screen =
            String(body.screen || '').trim().slice(0, 80);

        if (!FEEDBACK_TYPES.has(type)) {
            return res.status(400).json({
                error: 'invalid_feedback_type',
                message: 'Tipo de feedback inválido.'
            });
        }

        if (!FEEDBACK_SEVERITIES.has(severity)) {
            return res.status(400).json({
                error: 'invalid_feedback_severity',
                message: 'Prioridade de feedback inválida.'
            });
        }

        if (message.length < 8 || message.length > 1200) {
            return res.status(400).json({
                error: 'invalid_feedback_message',
                message: 'Descreva o feedback entre 8 e 1200 caracteres.'
            });
        }

        const firebaseAdmin = getFirebaseAdmin();

        if (!firebaseAdmin) {
            return res.status(503).json({
                error: 'firebase_admin_unavailable',
                message:
                    'Firebase Admin não foi inicializado no servidor.',
                detail:
                    firebaseAdminInitError?.message ||
                    'Credencial ausente ou inválida.'
            });
        }

        try {
            const firestore =
                firebaseAdmin.firestore();
            const userDoc =
                await firestore
                    .collection('users')
                    .doc(req.firebaseUser.uid)
                    .get();
            const userData =
                userDoc.data() || {};
            const pendingSnapshot =
                await firestore
                    .collection('support_tickets')
                    .where('user.uid', '==', req.firebaseUser.uid)
                    .limit(20)
                    .get();
            const hasPendingReply =
                pendingSnapshot.docs.some(doc => {
                    const ticket = doc.data() || {};
                    return !String(ticket.admin_reply?.message || '').trim();
                });

            if (hasPendingReply) {
                return res.status(409).json({
                    error: 'feedback_waiting_admin_reply',
                    message:
                        'Você já tem um feedback aberto. Aguarde uma resposta antes de enviar outro.'
                });
            }

            const now =
                admin.firestore.FieldValue.serverTimestamp();
            const ticketUser = {
                uid: req.firebaseUser.uid,
                email:
                    req.firebaseUser.email ||
                    userData.email ||
                    null,
                name:
                    userData.name ||
                    req.firebaseUser.name ||
                    null,
                church_id:
                    userData.church_id ||
                    null,
                is_admin:
                    userData.is_admin === true
            };
            const ticketRef =
                await firestore
                    .collection('support_tickets')
                    .add({
                        type,
                        severity,
                        message,
                        messages: [
                            supportMessage({
                                sender: 'user',
                                kind: 'feedback',
                                message,
                                uid: req.firebaseUser.uid,
                                name:
                                    userData.name ||
                                    req.firebaseUser.name ||
                                    req.firebaseUser.email ||
                                    'Usuário'
                            })
                        ],
                        screen: screen || null,
                        status: 'open',
                        source: 'api',
                        created_at: now,
                        updated_at: now,
                        user: ticketUser,
                        app: sanitizeSupportObject(body.app),
                        device: sanitizeSupportObject(body.device),
                        logs: sanitizeSupportLogs(body.logs),
                        request: {
                            ip:
                                String(req.headers['x-forwarded-for'] || '')
                                    .split(',')[0]
                                    .trim() ||
                                req.ip ||
                                null,
                            user_agent:
                                String(req.headers['user-agent'] || '')
                                    .slice(0, 300)
                        }
                    });

            let notificationResult = null;
            try {
                const recipients =
                    await supportRecipientsForTicket(
                        firestore,
                        ticketUser
                    );

                notificationResult =
                    await sendSystemNotificationToUsers(
                        firebaseAdmin,
                        firestore,
                        recipients,
                        {
                            title: 'Novo feedback recebido',
                            body:
                                `${ticketUser.name || ticketUser.email || 'Usuário'} enviou: ${message.slice(0, 100)}`,
                            data: {
                                type: 'support_ticket_created',
                                ticketId: ticketRef.id,
                                severity,
                                feedbackType: type
                            }
                        }
                    );
            } catch (notificationError) {
                console.error(
                    'Falha ao notificar novo feedback:',
                    notificationError.message
                );
            }

            return res.status(201).json({
                success: true,
                ticketId: ticketRef.id,
                notification: notificationResult
            });
        } catch (error) {
            console.error('Falha ao registrar feedback:', error);
            return res.status(500).json({
                error: 'feedback_write_failed',
                message: 'Não consegui registrar o feedback agora.'
            });
        }
    }
);

app.post(
    '/notificar',
    authenticateFirebaseUser,
    rateLimit({
        name: 'notification',
        windowMs: NOTIFICATION_RATE_LIMIT_WINDOW_MS,
        max: NOTIFICATION_RATE_LIMIT_MAX
    }),
    assertNotificationTargetsInSameChurch,
    authorizeNotificationAction,
    async (req, res) => {
        const {
            userIds,
            title,
            body,
            data
        } = req.body || {};

        if (!Array.isArray(userIds)) {
            return res.status(400).json({
                error: 'invalid_user_ids',
                message: 'userIds precisa ser uma lista de UIDs.'
            });
        }

        if (
            typeof title !== 'string' ||
            !title.trim() ||
            typeof body !== 'string' ||
            !body.trim()
        ) {
            return res.status(400).json({
                error: 'invalid_notification',
                message: 'Informe title e body.'
            });
        }

        const targetUserIds =
            req.notificationTargetUserIds || [];

        if (!targetUserIds.length) {
            return res.status(200).json({
                success: true,
                requestedUsers: 0,
                targetTokens: 0,
                sent: 0,
                failed: 0
            });
        }

        const firebaseAdmin = getFirebaseAdmin();

        if (!firebaseAdmin) {
            return res.status(503).json({
                error: 'firebase_admin_unavailable',
                message:
                    'Firebase Admin não foi inicializado no servidor.',
                detail:
                    firebaseAdminInitError?.message ||
                    'Credencial ausente ou inválida.'
            });
        }

        try {
            const firestore =
                firebaseAdmin.firestore();

            const userDocs =
                await Promise.all(
                    targetUserIds.map(uid =>
                        firestore
                            .collection('users')
                            .doc(uid)
                            .get()
                    )
                );

            const tokenToUserIds =
                new Map();

            for (let index = 0; index < userDocs.length; index++) {
                const userDoc = userDocs[index];

                if (!userDoc.exists) {
                    continue;
                }

                const userData =
                    userDoc.data() || {};

                const tokens = [];

                if (Array.isArray(userData.fcmTokens)) {
                    tokens.push(...userData.fcmTokens);
                }

                if (typeof userData.fcmToken === 'string') {
                    tokens.push(userData.fcmToken);
                }

                for (const token of tokens) {
                    const cleanToken =
                        String(token || '').trim();

                    if (!cleanToken) {
                        continue;
                    }

                    const uid =
                        targetUserIds[index];

                    const existing =
                        tokenToUserIds.get(cleanToken) || [];

                    existing.push(uid);
                    tokenToUserIds.set(cleanToken, existing);
                }
            }

            const tokens =
                [...tokenToUserIds.keys()].slice(0, 500);

            if (!tokens.length) {
                return res.status(200).json({
                    success: true,
                    requestedUsers: targetUserIds.length,
                    targetTokens: 0,
                    sent: 0,
                    failed: 0
                });
            }

            const response =
                await firebaseAdmin
                    .messaging()
                    .sendEachForMulticast({
                        tokens,
                        notification: {
                            title: title.trim(),
                            body: body.trim()
                        },
                        data:
                            normalizeNotificationData(data)
                    });

            const invalidTokens = [];

            response.responses.forEach((item, index) => {
                const code =
                    item.error?.code;

                if (
                    code === 'messaging/invalid-registration-token' ||
                    code === 'messaging/registration-token-not-registered'
                ) {
                    invalidTokens.push(tokens[index]);
                }
            });

            if (invalidTokens.length) {
                const cleanupPromises = [];

                for (const invalidToken of invalidTokens) {
                    const owners =
                        tokenToUserIds.get(invalidToken) || [];

                    for (const uid of owners) {
                        cleanupPromises.push(
                            firestore
                                .collection('users')
                                .doc(uid)
                                .set({
                                    fcmTokens:
                                        firebaseAdmin.firestore.FieldValue.arrayRemove(
                                            invalidToken
                                        )
                                }, { merge: true })
                        );
                    }
                }

                await Promise.allSettled(cleanupPromises);
            }

            return res.status(200).json({
                success: true,
                requestedUsers: targetUserIds.length,
                targetTokens: tokens.length,
                sent: response.successCount,
                failed: response.failureCount
            });
        } catch (error) {
            console.error(
                'Erro ao enviar notificações:',
                error.message
            );

            return res.status(500).json({
                error: 'notification_send_failed',
                message:
                    'Não foi possível enviar a notificação agora.'
            });
        }
    }
);

// ============================================================
// NORMALIZAÇÃO
// ============================================================

function normalizeText(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' e ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildGlobalCifraId(artist, track) {
    return `${artist}_${track}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

// ============================================================
// TOKENIZAÇÃO
// ============================================================

function tokenize(text) {
    return normalizeText(text)
        .split(' ')
        .filter(Boolean);
}

function addUniqueText(list, value) {
    const clean =
        String(value || '')
            .replace(/\s+/g, ' ')
            .trim();

    if (!clean) return;

    const key =
        normalizeText(clean);

    if (
        key &&
        !list.some(item => normalizeText(item) === key)
    ) {
        list.push(clean);
    }
}

// ============================================================
// PALAVRAS GENÉRICAS
// ============================================================

const GENERIC_WORDS = new Set([
    'ao',
    'aovivo',
    'vivo',
    'live',
    'medley',
    'pot',
    'pourri',
    'versao',
    'versao2',
    'versao3',
    'simplificada',
    'principal',
    'indefinida'
]);

// FIX: sem isso, palavras como "que" e "a" contavam como sobreposição
// de verdade entre duas músicas diferentes (foi o que fez "Ainda Que a
// Figueira" dar match com "Creio Que Tu És a Cura" com score 61,
// passando do piso de aceite). São palavras curtas e comuns demais pra
// distinguir uma música da outra.
const STOPWORDS = new Set([
    'a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos',
    'e', 'em', 'um', 'uma', 'uns', 'umas',
    'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'se',
    'que', 'ao', 'aos', 'a', 'as',
    // Em título de música, pronomes como "Teu", "Meu" e "Eu"
    // distinguem obras diferentes ("Tudo é Teu" não é
    // "Bem Mais Que Tudo"). Por isso eles ficam fora das stopwords.
    'es', 'sou', 'sao', 'foi', 'esta'
]);

function significantTokens(text) {
    return tokenize(text).filter(
        token =>
            !GENERIC_WORDS.has(token) &&
            !STOPWORDS.has(token)
    );
}

function hasSafeTitleMatch(requestedTrack, foundTitle) {
    const requested =
        normalizeText(coreTitle(requestedTrack));

    const found =
        normalizeText(coreTitle(foundTitle));

    if (!requested || !found) {
        return false;
    }

    if (requested === found) {
        return true;
    }

    const requestedTokens =
        significantTokens(requested);

    const foundTokens =
        significantTokens(found);

    if (!requestedTokens.length || !foundTokens.length) {
        return false;
    }

    if (requestedTokens.length === 1) {
        const token = requestedTokens[0];
        return token.length >= 4 && foundTokens.includes(token);
    }

    const allRequestedFound =
        requestedTokens.every(
            token => foundTokens.includes(token)
        );

    const allFoundRequested =
        foundTokens.every(
            token => requestedTokens.includes(token)
        );

    if (allRequestedFound) {
        return true;
    }

    if (allFoundRequested) {
        // Aceitar o título encontrado como subconjunto só é seguro
        // quando ele cobre quase todo o pedido. Isso evita aceitar
        // "Ruja o Leão" como se fosse "Ruja o Leão / Talita Cumi".
        return foundTokens.length >= Math.ceil(requestedTokens.length * 0.75);
    }

    return similarity(requested, found) >= 0.62;
}

function compositeTrackParts(track) {
    return String(track || '')
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .split(/\s*(?:\/|\+)\s*/)
        .map(part => part.trim())
        .filter(Boolean);
}

function hasCompositeTrackCoverage(requestedTrack, foundTitle, content = '') {
    const parts = compositeTrackParts(requestedTrack);

    if (parts.length < 2) {
        return true;
    }

    const titleText = normalizeText(foundTitle);
    const contentText = normalizeText(content);

    return parts.every(part => {
        const partTokens = significantTokens(part)
            .filter(token => token.length >= 4);

        if (!partTokens.length) {
            return true;
        }

        const coveredByTitle =
            partTokens.every(token =>
                titleText.includes(token)
            );

        const coveredByContent =
            partTokens.every(token =>
                contentText.includes(token)
            );

        return coveredByTitle || coveredByContent;
    });
}

// FIX: parênteses/colchetes atrapalham a pontuação tanto quanto
// atrapalhavam a geração de slug — mas antes só eram removidos na
// hora de montar o slug, nunca na hora de comparar/pontuar. O caso
// real: "Rendido Estou (Arms Open Wide)" (pedido) vs "Rendido Estou
// (part. Fernandinho e Bruna Karla)" (página real) — dois parênteses
// que não têm nada a ver um com o outro, derrubando o score de uma
// música que na real bate 100%.
function coreTitle(text) {
    return String(text || '')
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .trim();
}

// ============================================================
// SLUG ARTISTA
// ============================================================

function formatArtistSlug(text) {
    let clean = String(text || '').trim();

    clean = clean
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '');

    clean = clean
        .split(',')[0]
        .split('&')[0]
        .split('+')[0]
        .split(/\s+feat\.?\s+/i)[0]
        .split(/\s+part\.?\s+/i)[0]
        .trim();

    const normalized = normalizeText(clean);

    // Aliases importantes
    const aliases = {
        'morada': 'ministerio-morada',
        'ministerio morada': 'ministerio-morada',

        'fhop': 'florianopolis-house-of-prayer',
        'fhop music': 'florianopolis-house-of-prayer',

        'florianopolis house of prayer':
            'florianopolis-house-of-prayer',

        'aline barros': 'aline-barros',
        'kemuel': 'coral-kemuel',
        'grupo kemuel': 'coral-kemuel',
        'coral kemuel': 'coral-kemuel',
        'kellen byanca': 'kellen-byanca-ofc',

        // O Cifra Club e outros provedores usam o nome completo da
        // comunidade, mas catálogos musicais costumam trazer só
        // "Colo de Deus".
        'colo de deus': 'comunidade-catolica-colo-de-deus',
        'comunidade colo de deus': 'comunidade-catolica-colo-de-deus',
        'comunidade catolica colo de deus':
            'comunidade-catolica-colo-de-deus',

        // O catálogo de onde o app puxa resultados às vezes vem com o
        // nome civil completo, mas o Cifra Club usa o nome artístico.
        'gabriel guedes': 'gabriel-guedes',
        'gabriel guedes de almeida': 'gabriel-guedes',

        // Confirmado ao vivo contra o site: o slug real é só "nadson",
        // sem "o ferinha" — decisão editorial do Cifra Club, impossível
        // de deduzir por regra.
        'nadson o ferinha': 'nadson'
    };

    if (aliases[normalized]) {
        return aliases[normalized];
    }

    return normalized.replace(/\s+/g, '-');
}

function generateArtistNameVariants(artist) {
    const original =
        String(artist || '')
            .replace(/\(.*?\)/g, '')
            .replace(/\[.*?\]/g, '')
            .replace(/\{.*?\}/g, '')
            .trim();

    const variants = [];

    addUniqueText(variants, original);

    const splitText =
        original
            .replace(/\s+(?:feat|ft|part|partic|participacao|participação)\.?\s+/gi, ' & ')
            .replace(/\s+(?:com|with)\s+/gi, ' & ');

    const parts =
        splitText
            .split(/\s*(?:,|&|\+|\be\b)\s*/i)
            .map(part => part.trim())
            .filter(Boolean);

    for (const part of parts) {
        addUniqueText(variants, part);
    }

    const snapshot = [...variants];

    for (const value of snapshot) {
        const normalized =
            normalizeText(value);

        const words =
            normalized
                .split(' ')
                .filter(Boolean);

        if (words.length >= 3) {
            addUniqueText(
                variants,
                words.slice(0, 2).join(' ')
            );
        }

        const withoutCivilSuffix =
            normalized
                .replace(/\s+de\s+[a-z0-9]+$/i, '')
                .replace(/\s+da\s+[a-z0-9]+$/i, '')
                .replace(/\s+do\s+[a-z0-9]+$/i, '')
                .trim();

        if (
            withoutCivilSuffix &&
            withoutCivilSuffix !== normalized &&
            withoutCivilSuffix.split(' ').length >= 2
        ) {
            addUniqueText(variants, withoutCivilSuffix);
        }
    }

    return variants;
}

// ============================================================
// POSSÍVEIS SLUGS DO ARTISTA
// ============================================================

function generateArtistSlugs(artist) {
    const original = String(artist || '').trim();

    const normalized = normalizeText(original);

    const result = [];

    function add(value) {
        if (!value) return;

        const slug = String(value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .toLowerCase();

        if (slug && !result.includes(slug)) {
            result.push(slug);
        }
    }

    for (const variant of generateArtistNameVariants(original)) {
        add(formatArtistSlug(variant));
        add(normalizeText(variant));
    }

    // Heurística geral (além do alias específico acima): vários artistas
    // "de nome composto" no Cifra Club usam só a primeira palavra como
    // slug — foi exatamente o caso do "nadson o ferinha" -> "nadson".
    // Custa pouco tentar, e a validação por score protege contra pegar
    // o artista errado por engano.
    for (const variant of generateArtistNameVariants(original)) {
        const firstWord =
            normalizeText(variant).split(' ')[0];

        if (firstWord && firstWord.length > 2) {
            add(firstWord);
        }
    }

    if (normalized === 'morada') {
        add('ministerio-morada');
    }

    if (normalized === 'ministerio morada') {
        add('morada');
        add('ministerio-morada');
    }

    if (normalized === 'aline') {
        add('aline-barros');
    }

    if (normalized === 'aline barros') {
        add('aline');
        add('aline-barros');
    }

    if (
        normalized === 'kemuel' ||
        normalized === 'grupo kemuel' ||
        normalized === 'coral kemuel'
    ) {
        add('coral-kemuel');
    }

    if (normalized === 'kellen byanca') {
        add('kellen-byanca-ofc');
    }

    if (
        normalized === 'gabriel guedes' ||
        normalized === 'gabriel guedes de almeida'
    ) {
        add('gabriel-guedes');
    }

    return result;
}

// ============================================================
// SLUG DA MÚSICA
// ============================================================

function basicTrackSlug(text) {
    let clean = String(text || '');

    clean = clean
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/\{.*?\}/g, '');

    clean = clean
        .replace(/[\/|]/g, ' ')
        .replace(/&/g, ' e ');

    clean = clean
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return clean.replace(/\s+/g, '-');
}

function generateTrackTitleVariants(track) {
    const original =
        String(track || '')
            .replace(/\s+/g, ' ')
            .trim();

    const variants = [];

    function addWithPraPara(value) {
        addUniqueText(variants, value);

        const clean =
            String(value || '');

        addUniqueText(
            variants,
            clean.replace(/\bpra\b/gi, 'para')
        );

        addUniqueText(
            variants,
            clean.replace(/\bpara\b/gi, 'pra')
        );
    }

    addWithPraPara(original);
    addWithPraPara(coreTitle(original));

    const withoutFeaturing =
        original
            .replace(/\s+(?:feat|ft|part|partic|participacao|participação)\.?\s+.*$/i, '')
            .trim();

    addWithPraPara(withoutFeaturing);

    const withoutVersionWords =
        coreTitle(original)
            .replace(/\b(?:ao vivo|live|acustico|acústico|versao|versão|remix|playback)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

    addWithPraPara(withoutVersionWords);

    const firstPart =
        coreTitle(original)
            .split('/')
            .map(part => part.trim())
            .filter(Boolean)[0];

    addWithPraPara(firstPart);

    return variants;
}

function extractFeaturingSlug(track) {
    const match =
        String(track || '').match(
            /\((?:feat|ft|part|partic|participacao|participação)\.?\s*([^)]+)\)/i
        ) ||
        String(track || '').match(
            /\s+(?:feat|ft|part|partic|participacao|participação)\.?\s+(.+)$/i
        );

    if (!match) {
        return '';
    }

    return basicTrackSlug(match[1]);
}

// ============================================================
// POSSÍVEIS SLUGS DA MÚSICA
// ============================================================

function generateTrackSlugs(track) {
    const result = [];

    function add(value) {
        if (!value) return;

        const slug = String(value)
            .replace(/^-+|-+$/g, '')
            .replace(/-+/g, '-');

        if (slug && !result.includes(slug)) {
            result.push(slug);
        }
    }

    for (const variant of generateTrackTitleVariants(track)) {
        const base = basicTrackSlug(variant);
        const featuringSlug = extractFeaturingSlug(track);

        add(base);

        // Remove informações de apresentação
        add(
            base
                .replace(/-ao-vivo$/g, '')
                .replace(/-live$/g, '')
                .replace(/-medley$/g, '')
                .replace(/-pot-pourri$/g, '')
        );

        // Adiciona formatos comuns do Cifra Club
        add(`${base}-ao-vivo`);
        add(`${base}-medley`);
        add(`${base}-pot-pourri`);

        add(`${base}-ao-vivo-medley`);
        add(`${base}-ao-vivo-pot-pourri`);

        add(`${base}-medley-2`);
        add(`${base}-pot-pourri-2`);
        add(`${base}-2`);
        add(`${base}-3`);

        if (featuringSlug) {
            add(`${base}-part-${featuringSlug}`);
            add(`${base}-ft-${featuringSlug}`);
            add(`${base}-feat-${featuringSlug}`);
        }
    }

    const knownAliases = {
        'diz': [
            'diz-you-say'
        ],
        'oh-quao-lindo-esse-nome-e': [
            'oh-quao-lindo-esse-nome-e-what-a-beautiful-name'
        ],
        'ovelha-em-treinamento': [
            'ovelha-em-treinamento'
        ]
    };

    for (const alias of knownAliases[basicTrackSlug(track)] || []) {
        add(alias);
    }

    // ========================================================
    // MEDLEYS
    // ========================================================

    const parts = String(track)
        .replace(/\(.*?\)/g, '')
        .replace(/\[.*?\]/g, '')
        .split('/')
        .map(part => part.trim())
        .filter(Boolean);

    if (parts.length > 1) {
        const first = basicTrackSlug(parts[0]);

        add(first);

        for (const suffix of [
            'ao-vivo',
            'medley',
            'pot-pourri'
        ]) {
            add(`${first}-${suffix}`);
        }

        // Combinação das partes sem caracteres especiais
        const combined = parts
            .map(part => basicTrackSlug(part))
            .filter(Boolean)
            .join('-');

        add(combined);
        add(`${combined}-ao-vivo`);
        add(`${combined}-medley`);
        add(`${combined}-pot-pourri`);
    }

    return [...new Set(result)];
}

// ============================================================
// URLS DIRETAS
// ============================================================

function generateDirectCandidates(artist, track) {
    const artistSlugs = generateArtistSlugs(artist);
    const trackSlugs = generateTrackSlugs(track);

    const urls = [];

    for (const artistSlug of artistSlugs) {
        for (const trackSlug of trackSlugs) {
            urls.push(
                `${CIFRA_BASE}/${artistSlug}/${trackSlug}/`
            );
        }
    }

    return [...new Set(urls)];
}

// ============================================================
// CACHE
// ============================================================

function cleanCache(map, ttl, maxItems = MAX_CACHE_ITEMS) {
    const now = Date.now();

    for (const [key, value] of map) {
        if (now - value.createdAt > ttl) {
            map.delete(key);
        }
    }

    while (map.size > maxItems) {
        const first = map.keys().next().value;

        if (first) {
            map.delete(first);
        } else {
            break;
        }
    }
}

function saveSongCache(key, data) {
    cleanCache(songCache, CACHE_TTL);
    songCache.set(key, {
        data,
        createdAt: Date.now()
    });
}

function getSongCache(key) {
    const item = songCache.get(key);

    if (!item) return null;

    if (Date.now() - item.createdAt > CACHE_TTL) {
        songCache.delete(key);
        return null;
    }

    return item.data;
}

function isSearchResultSafeForRequest(artist, track, result) {
    if (!result) {
        return false;
    }

    if (!hasSafeTitleMatch(track, result.title || '')) {
        return false;
    }

    if (!hasCompositeTrackCoverage(
        track,
        result.title || '',
        result.content || ''
    )) {
        return false;
    }

    if (!looksLikeChordContent(result.content || '')) {
        return false;
    }

    return true;
}

const NOTE_INDEX = {
    C: 0,
    'C#': 1,
    Db: 1,
    D: 2,
    'D#': 3,
    Eb: 3,
    E: 4,
    F: 5,
    'F#': 6,
    Gb: 6,
    G: 7,
    'G#': 8,
    Ab: 8,
    A: 9,
    'A#': 10,
    Bb: 10,
    B: 11
};

const SHARP_SCALE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_SCALE = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function normalizeKeyValue(value) {
    const text = String(value || '')
        .trim()
        .replace(/♯/g, '#')
        .replace(/♭/g, 'b')
        .replace(/^tom\s*:\s*/i, '');

    const match =
        text.match(/(?:^|[^A-Za-z])([A-Ga-g])(#|b)?(m)?(?=$|[^A-Za-z])/);

    if (!match) return '';

    let note =
        `${match[1].toUpperCase()}${match[2] || ''}`;

    if (note === 'A#') note = 'Bb';
    if (note === 'D#') note = 'Eb';
    if (note === 'G#') note = 'Ab';

    return `${note}${match[3] ? 'm' : ''}`;
}

function removeMinorKey(key) {
    const normalized = normalizeKeyValue(key);
    return normalized.endsWith('m')
        ? normalized.slice(0, -1)
        : normalized;
}

function isMinorKeyValue(key) {
    return /^[A-G](?:#|b)?m$/.test(normalizeKeyValue(key));
}

function wrap12(value) {
    const result = value % 12;
    return result < 0 ? result + 12 : result;
}

function transposeKeyValue(key, semitones) {
    const normalized = normalizeKeyValue(key);
    if (!normalized) return '';

    const root = removeMinorKey(normalized);
    const index = NOTE_INDEX[root];
    if (index === undefined) return normalized;

    const preferFlats = root.includes('b') || normalized.includes('b');
    const scale = preferFlats ? FLAT_SCALE : SHARP_SCALE;
    const target = scale[wrap12(index + semitones)];

    return isMinorKeyValue(normalized)
        ? `${target}m`
        : target;
}

function chordRootQuality(token) {
    const value = String(token || '').trim();
    const match = value.match(/^([A-G](?:#|b)?)(.*)$/);
    if (!match) return '';

    const rest = String(match[2] || '').toLowerCase();
    const minor = rest.startsWith('m') && !rest.startsWith('maj');
    return normalizeKeyValue(`${match[1]}${minor ? 'm' : ''}`);
}

function isLikelyChordLine(line) {
    const tokens = String(line || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;

    let chords = 0;
    for (const token of tokens) {
        if (chordRootQuality(token)) chords++;
    }

    return chords > 0 && chords >= tokens.length / 2;
}

function countChordRoot(content, key) {
    const target = normalizeKeyValue(key);
    if (!target) return 0;

    let count = 0;
    for (const line of String(content || '').split('\n')) {
        if (!isLikelyChordLine(line)) continue;

        for (const token of line.trim().split(/\s+/)) {
            if (chordRootQuality(token) === target) {
                count++;
            }
        }
    }

    return count;
}

function minorRealKeyFromShape(originalKey, minorShape, capo) {
    const inferred = transposeKeyValue(minorShape, capo);
    const originalRoot = removeMinorKey(originalKey);

    if (
        NOTE_INDEX[originalRoot] !== undefined &&
        NOTE_INDEX[originalRoot] === NOTE_INDEX[removeMinorKey(inferred)]
    ) {
        return `${originalRoot}m`;
    }

    return inferred;
}

function repairSongKeyInfo(data) {
    const response = { ...data };
    const capoMatch = String(response.capo || '').match(/\d+/);
    const capoNumber = capoMatch ? Number(capoMatch[0]) : 0;

    let originalKey = normalizeKeyValue(response.originalKey);
    let shapeKey = normalizeKeyValue(response.shapeKey);

    if (shapeKey && !isMinorKeyValue(shapeKey)) {
        const minorShape = `${removeMinorKey(shapeKey)}m`;
        const minorCount = countChordRoot(response.content, minorShape);
        const majorCount = countChordRoot(response.content, shapeKey);

        if (minorCount > majorCount) {
            shapeKey = minorShape;
        }
    }

    if (shapeKey && isMinorKeyValue(shapeKey) && !isMinorKeyValue(originalKey) && capoNumber > 0) {
        originalKey = minorRealKeyFromShape(originalKey, shapeKey, capoNumber);
    }

    response.originalKey = originalKey || 'C';
    response.shapeKey = shapeKey || '';
    response.capo = capoMatch ? capoMatch[0] : String(response.capo || '');

    return response;
}

async function getGlobalSongCache(artist, track) {
    const firebaseAdmin = getFirebaseAdmin();
    if (!firebaseAdmin) return null;

    try {
        const docId = buildGlobalCifraId(artist, track);
        const snapshot = await firebaseAdmin
            .firestore()
            .collection('global_cifras')
            .doc(docId)
            .get();

        if (!snapshot.exists) return null;

        const cached = snapshot.data() || {};
        const response = repairSongKeyInfo({
            title: cached.title || track,
            artist: cached.artist || artist,
            originalKey: cached.originalKey || 'C',
            shapeKey: cached.shapeKey || '',
            capo: cached.capo || '',
            content: cached.content || '',
            url: cached.url || '',
            source: cached.source || 'global_cache',
            searchScore: cached.searchScore || 100
        });

        if (!isSearchResultSafeForRequest(artist, track, response)) {
            console.warn(
                `Cache global ignorado por baixa correspondência: ${artist} - ${track} -> ${response.title}`
            );

            await snapshot.ref.delete().catch(error => {
                console.warn(
                    'Falha ao remover cache global inválido:',
                    error.message
                );
            });

            return null;
        }

        if (
            response.originalKey !== (cached.originalKey || 'C') ||
            response.shapeKey !== (cached.shapeKey || '') ||
            response.capo !== (cached.capo || '')
        ) {
            saveGlobalSongCache(artist, track, response);
        }

        saveSongCache(`${normalizeText(artist)}::${normalizeText(track)}`, response);
        return response;
    } catch (error) {
        console.warn(
            'Falha ao consultar cache global:',
            error.message
        );
        return null;
    }
}

async function saveGlobalSongCache(artist, track, data) {
    const firebaseAdmin = getFirebaseAdmin();
    if (!firebaseAdmin) return;

    try {
        const docId = buildGlobalCifraId(artist, track);
        const repaired = repairSongKeyInfo(data);

        if (!isSearchResultSafeForRequest(artist, track, repaired)) {
            console.warn(
                `Cache global não salvo por baixa correspondência: ${artist} - ${track} -> ${repaired.title}`
            );

            return;
        }

        await firebaseAdmin
            .firestore()
            .collection('global_cifras')
            .doc(docId)
            .set({
                id: docId,
                title: repaired.title || track,
                artist: repaired.artist || artist,
                originalKey: repaired.originalKey || 'C',
                shapeKey: repaired.shapeKey || '',
                capo: repaired.capo || '',
                content: repaired.content || '',
                url: repaired.url || '',
                source: repaired.source || '',
                searchScore: repaired.searchScore || 0,
                created_at: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                updated_at: firebaseAdmin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
    } catch (error) {
        console.warn(
            'Falha ao salvar cache global:',
            error.message
        );
    }
}

function saveCatalogCache(key, data) {
    cleanCache(catalogCache, CATALOG_TTL);
    catalogCache.set(key, {
        data,
        createdAt: Date.now()
    });
}

function getCatalogCache(key) {
    const item = catalogCache.get(key);

    if (!item) return null;

    if (Date.now() - item.createdAt > CATALOG_TTL) {
        catalogCache.delete(key);
        return null;
    }

    return item.data;
}

// ============================================================
// HTTP
// ============================================================

async function fetchHtml(url) {
    try {
        const response = await axios.get(url, {
            timeout: REQUEST_TIMEOUT,
            headers: HEADERS,
            maxRedirects: 5,
            validateStatus: status =>
                status >= 200 && status < 400
        });

        return {
            html: response.data,
            finalUrl: response.request?.res?.responseUrl || url,
            status: response.status
        };
    } catch (error) {
        return null;
    }
}

// ============================================================
// VALIDAR URL DO CIFRA CLUB
// ============================================================

function isValidCifraClubUrl(url) {
    try {
        const parsed = new URL(url);

        if (
            parsed.hostname !== 'www.cifraclub.com.br' &&
            parsed.hostname !== 'cifraclub.com.br'
        ) {
            return false;
        }

        const path = parsed.pathname.toLowerCase();

        // Nunca aceitar páginas genéricas
        const blocked = [
            '/letra/',
            '/search/',
            '/navegador/',
            '/wiki/',
            '/marketplace/',
            '/forum/',
            '/videos/',
            '/partituras/',
            '/tabs/',
            '/guitar-pro/'
        ];

        if (
            blocked.some(item => path.includes(item))
        ) {
            return false;
        }

        if (path.endsWith('/musicas.html')) {
            return false;
        }

        const parts = path
            .split('/')
            .filter(Boolean);

        // Precisa ter pelo menos:
        // /artista/musica/
        if (parts.length < 2) {
            return false;
        }

        return true;
    } catch (e) {
        return false;
    }
}

const BAD_LINK_TITLES = new Set([
    '',
    'opcoes',
    'opcao',
    'mais',
    'cifra',
    'letra',
    'principal',
    'simplificada'
]);

function titleFromCifraClubUrl(url) {
    try {
        const parsed =
            new URL(url);

        const parts =
            parsed.pathname
                .split('/')
                .filter(Boolean);

        if (parts.length < 2) {
            return '';
        }

        return parts[1]
            .replace(/-/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    } catch (error) {
        return '';
    }
}

function cleanLinkTitle(rawTitle, url) {
    const title =
        String(rawTitle || '')
            .replace(/\s+/g, ' ')
            .trim();

    const normalized =
        normalizeText(title);

    if (
        !title ||
        title.length < 3 ||
        BAD_LINK_TITLES.has(normalized) ||
        normalized.includes('opcoes')
    ) {
        return titleFromCifraClubUrl(url);
    }

    return title;
}

// ============================================================
// PROVEDORES ALTERNATIVOS DE CIFRA
// ============================================================

const ALTERNATIVE_CIFRA_PROVIDERS = [
    {
        source: 'cifras_com_br',
        label: 'Cifras',
        baseUrl: 'https://www.cifras.com.br',
        hostnames: new Set([
            'www.cifras.com.br',
            'cifras.com.br'
        ]),
        pathPrefix: '/cifra/',
        searchDomain: 'cifras.com.br/cifra'
    },
    {
        source: 'cifras_gospel_online',
        label: 'Cifras Gospel Online',
        baseUrl: 'https://cifrasgospel.online',
        hostnames: new Set([
            'cifrasgospel.online',
            'www.cifrasgospel.online'
        ]),
        pathPrefix: '/cifra/',
        searchDomain: 'cifrasgospel.online/cifra'
    }
];

function buildAlternativeProviderUrl(
    provider,
    artistSlug,
    trackSlug
) {
    return `${provider.baseUrl}${provider.pathPrefix}${artistSlug}/${trackSlug}/`;
}

function isValidAlternativeProviderUrl(
    provider,
    url
) {
    try {
        const parsed =
            new URL(url);

        if (
            !provider.hostnames.has(
                parsed.hostname
            )
        ) {
            return false;
        }

        const path =
            parsed.pathname.toLowerCase();

        if (
            !path.startsWith(
                provider.pathPrefix
            )
        ) {
            return false;
        }

        const blocked = [
            '/letra/',
            '/videos/',
            '/video/',
            '/artistas/',
            '/playlist/',
            '/blog/',
            '/buscar',
            '/search'
        ];

        if (
            blocked.some(item =>
                path.includes(item)
            )
        ) {
            return false;
        }

        const parts =
            path
                .split('/')
                .filter(Boolean);

        // /cifra/artista/musica
        return parts.length >= 3;
    } catch (error) {
        return false;
    }
}

function alternativeProviderForUrl(url) {
    return ALTERNATIVE_CIFRA_PROVIDERS.find(provider =>
        isValidAlternativeProviderUrl(
            provider,
            url
        )
    );
}

function titleFromAlternativeProviderUrl(url) {
    try {
        const parsed =
            new URL(url);

        const parts =
            parsed.pathname
                .split('/')
                .filter(Boolean);

        if (parts.length < 3) {
            return '';
        }

        return parts
            .slice(2)
            .join(' ')
            .replace(/-/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    } catch (error) {
        return '';
    }
}

function cleanAlternativeLinkTitle(rawTitle, url) {
    const title =
        String(rawTitle || '')
            .replace(/\s+/g, ' ')
            .trim();

    const normalized =
        normalizeText(title);

    if (
        !title ||
        title.length < 3 ||
        BAD_LINK_TITLES.has(normalized) ||
        normalized.includes('opcoes') ||
        normalized.includes('anuncio')
    ) {
        return titleFromAlternativeProviderUrl(url);
    }

    return title;
}

function extractAlternativeProviderContent($, provider) {
    if (provider.source === 'cifras_gospel_online') {
        const parts = [];

        $('pre.wp-block-verse, article pre, main pre, pre').each(
            (index, element) => {
                const text =
                    $(element)
                        .text()
                        .replace(/\u00a0/g, ' ')
                        .trim();

                const normalized =
                    normalizeText(text);

                if (
                    !text ||
                    text.length < 3 ||
                    BAD_LINK_TITLES.has(normalized) ||
                    normalized === 'btn'
                ) {
                    return;
                }

                parts.push(text);
            }
        );

        const combined =
            parts
                .join('\n')
                .trim();

        if (combined) {
            return combined;
        }
    }

    return extractChordContent($);
}

function extractAlternativeProviderMetadata(
    $,
    provider,
    url,
    requestedArtist
) {
    let title =
        $('h1').first().text().trim();

    let artist = '';

    const pageTitle =
        $('title').first().text().trim();

    const patterns = [
        /^(.+?)\s+-\s+(.+?)\s+\|\s*CIFRAS/i,
        /^(.+?)\s+-\s+(.+?)\s+-\s+Cifra/i,
        /^(.+?)\s+cifra\s+(.+?)$/i
    ];

    for (const pattern of patterns) {
        const match =
            pageTitle.match(pattern);

        if (match) {
            title =
                title || match[1].trim();

            artist =
                match[2].trim();
            break;
        }
    }

    if (!title) {
        const ogTitle =
            $('meta[property="og:title"]')
                .attr('content') ||
            $('meta[name="twitter:title"]')
                .attr('content') ||
            '';

        title =
            String(ogTitle)
                .replace(/\s*-\s*Cifra.*$/i, '')
                .trim();
    }

    if (!title) {
        title =
            titleFromAlternativeProviderUrl(url);
    }

    if (
        !artist ||
        BAD_ARTIST_VALUES.has(
            normalizeText(artist)
        )
    ) {
        artist = requestedArtist;
    }

    return {
        title,
        artist,
        provider:
            provider.label
    };
}

// ============================================================
// TEXTO DA CIFRA
// ============================================================

function extractChordContent($) {
    const candidates = [];

    $('pre').each((index, element) => {
        const text = $(element).text();

        if (text && text.trim().length > 0) {
            candidates.push(text);
        }
    });

    $('main pre').each((index, element) => {
        const text = $(element).text();

        if (text && text.trim().length > 0) {
            candidates.push(text);
        }
    });

    $('article pre').each((index, element) => {
        const text = $(element).text();

        if (text && text.trim().length > 0) {
            candidates.push(text);
        }
    });

    // Alguns layouts podem colocar a cifra em containers
    $('[class*="cifra"]').each((index, element) => {
        const text = $(element).text();

        if (
            text &&
            text.trim().length > 100 &&
            text.length < 100000
        ) {
            candidates.push(text);
        }
    });

    if (!candidates.length) {
        return '';
    }

    candidates.sort(
        (a, b) => b.length - a.length
    );

    return candidates[0].trim();
}

// ============================================================
// VERIFICA SE É REALMENTE UMA CIFRA
// ============================================================

function looksLikeChordContent(content) {
    if (!content) return false;

    const text = content.trim();

    if (text.length < 80) {
        return false;
    }

    // Acordes comuns
    const chordMatches = text.match(
        /\b[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus|add|M)?\d*(?:\/[A-G](?:#|b)?)?\b/g
    );

    const chordCount =
        chordMatches ? chordMatches.length : 0;

    // Tablatura também conta
    const hasTab =
        /E\|[-0-9hHpPbB\/\\|]+/i.test(text) ||
        /B\|[-0-9hHpPbB\/\\|]+/i.test(text);

    return chordCount >= 4 || hasTab;
}

// ============================================================
// LIMPEZA
// ============================================================

function cleanSongContent(content) {
    return String(content || '')
        .replace(/\[\/?(b|i)\]/gi, '')
        .replace(/\r/g, '')
        .split('\n')
        .filter(line => line.trim())
        .join('\n')
        .trim();
}

// ============================================================
// METADADOS
// ============================================================

// FIX: $('h2').first() estava pegando um heading de navegação
// ("Menu principal") em quase toda página, não o nome do artista.
// A description da página segue o padrão "Título - Artista - Cifra
// Club" de forma bem mais confiável, então agora ela é tentada
// primeiro; o h2 só entra como fallback, e nunca se o texto bater
// com um valor conhecido de "lixo" de navegação.
const BAD_ARTIST_VALUES = new Set([
    'menu principal',
    'menu',
    'cifra club',
    'navegacao',
    ''
]);

function extractPageMetadata($) {
    let title =
        $('h1').first().text().trim();

    let artist = '';

    const description =
        $('meta[name="description"]')
            .attr('content') || '';

    const descMatch =
        description.match(
            /-\s*([^-]+?)\s*-\s*Cifra Club/i
        );

    if (descMatch) {
        artist = descMatch[1].trim();
    }

    if (
        !artist ||
        BAD_ARTIST_VALUES.has(
            normalizeText(artist)
        )
    ) {
        const h2Text =
            $('h2').first().text().trim();

        if (
            h2Text &&
            !BAD_ARTIST_VALUES.has(
                normalizeText(h2Text)
            )
        ) {
            artist = h2Text;
        }
    }

    if (!title) {
        const ogTitle =
            $('meta[property="og:title"]')
                .attr('content');

        if (ogTitle) {
            title = ogTitle
                .replace(/\s*-\s*Cifra Club.*$/i, '')
                .trim();
        }
    }

    return {
        title,
        artist
    };
}

// ============================================================
// INFORMAÇÕES DE TOM
// ============================================================

function extractKeyInfo($, contentText) {
    const bodyText = $('body')
        .text()
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n+/g, '\n')
        .trim();

    let originalKey = '';
    let shapeKey = '';
    let capo = '';

    // ========================================================
    // TOM
    // ========================================================

    const keyMatch = bodyText.match(
        /tom:\s*([A-G](?:#|b)?m?)(?:\s*\(\s*(?:com\s+)?forma\s+(?:dos\s+acordes\s+)?(?:no\s+tom\s+de\s*|de\s*)?([A-G](?:#|b)?m?)\s*\))?/i
    );

    if (keyMatch) {
        originalKey = keyMatch[1].trim();
        shapeKey =
            keyMatch[2]?.trim() || '';
    }

    // Outra forma encontrada no site
    if (!originalKey) {
        const alternativeKey =
            bodyText.match(
                /Tom:\s*([A-G](?:#|b)?m?)/i
            );

        if (alternativeKey) {
            originalKey =
                alternativeKey[1].trim();
        }
    }

    // ========================================================
    // FORMA
    // ========================================================

    if (!shapeKey) {
        const shapeMatch =
            bodyText.match(
                /forma(?:\s+dos\s+acordes)?\s+(?:no\s+tom\s+de|de)\s*([A-G](?:#|b)?m?)/i
            );

        if (shapeMatch) {
            shapeKey =
                shapeMatch[1].trim();
        }
    }

    // ========================================================
    // CAPO
    // ========================================================

    const capoPatterns = [
        /Capotraste:\s*(\d+)\s*(?:ª|a|º|°)?\s*casa/i,
        /Capotraste\s+na\s+(\d+)\s*(?:ª|a|º|°)?\s*casa/i,
        /capo:\s*(\d+)/i,
        /capotraste\s+(\d+)/i
    ];

    for (const pattern of capoPatterns) {
        const match = bodyText.match(pattern);

        if (match) {
            capo = match[1];
            break;
        }
    }

    // ========================================================
    // FALLBACK PELO PRIMEIRO ACORDE
    // ========================================================

    if (!originalKey) {
        const firstChordMatch =
            contentText.match(
                /\b([A-G](?:#|b)?m?)(?:maj|dim|aug|sus|add|M)?\d*(?:\/[A-G](?:#|b)?)?\b/
            );

        if (firstChordMatch) {
            originalKey =
                firstChordMatch[1];
        }
    }

    if (!shapeKey && originalKey) {
        shapeKey = originalKey;
    }

    return {
        originalKey,
        shapeKey,
        capo
    };
}

// ============================================================
// SIMILARIDADE
// ============================================================

function similarity(a, b) {
    const aTokens =
        significantTokens(a);

    const bTokens =
        significantTokens(b);

    if (!aTokens.length || !bTokens.length) {
        return 0;
    }

    const aSet = new Set(aTokens);
    const bSet = new Set(bTokens);

    let intersection = 0;

    for (const token of aSet) {
        if (bSet.has(token)) {
            intersection++;
        }
    }

    const union =
        new Set([
            ...aSet,
            ...bSet
        ]).size;

    const jaccard =
        union > 0
            ? intersection / union
            : 0;

    const containmentA =
        intersection / aSet.size;

    const containmentB =
        intersection / bSet.size;

    return Math.max(
        jaccard,
        containmentA * 0.95,
        containmentB * 0.90
    );
}

// ============================================================
// SCORE DA MÚSICA
// ============================================================

function scoreSong(requestedArtist, requestedTrack, foundArtist, foundTitle) {
    const coreRequestedTrack = coreTitle(requestedTrack);
    const coreFoundTitle = coreTitle(foundTitle);

    const titleSimilarity =
        similarity(
            coreRequestedTrack,
            coreFoundTitle
        );

    const artistSimilarity =
        similarity(
            requestedArtist,
            foundArtist
        );

    let score =
        titleSimilarity * 75 +
        artistSimilarity * 25;

    const normalizedRequested =
        normalizeText(coreRequestedTrack);

    const normalizedFound =
        normalizeText(coreFoundTitle);

    if (
        normalizedRequested ===
        normalizedFound
    ) {
        score += 30;
    }

    const requestedTokens =
        significantTokens(coreRequestedTrack);

    const foundTokens =
        significantTokens(coreFoundTitle);

    if (
        requestedTokens.length > 0 &&
        requestedTokens.every(
            token => foundTokens.includes(token)
        )
    ) {
        score += 15;
    }

    return score;
}

// ============================================================
// BUSCA E VALIDA UMA PÁGINA
// ============================================================

async function inspectSongUrl(
    url,
    requestedArtist,
    requestedTrack
) {
    if (!isValidCifraClubUrl(url)) {
        return null;
    }

    const page = await fetchHtml(url);

    if (!page) {
        return null;
    }

    const $ =
        cheerio.load(page.html);

    const content =
        extractChordContent($);

    if (!looksLikeChordContent(content)) {
        return null;
    }

    const metadata =
        extractPageMetadata($);

    const pageTitle =
        metadata.title || requestedTrack;

    const pageArtist =
        metadata.artist || requestedArtist;

    const score =
        scoreSong(
            requestedArtist,
            requestedTrack,
            pageArtist,
            pageTitle
        );

    // ========================================================
    // NÃO ACEITAR RESULTADO MUITO DISTANTE
    // ========================================================

    if (
        score < 45 ||
        !hasSafeTitleMatch(
            requestedTrack,
            pageTitle
        ) ||
        !hasCompositeTrackCoverage(
            requestedTrack,
            pageTitle,
            content
        )
    ) {
        return null;
    }

    const keyInfo =
        extractKeyInfo(
            $,
            content
        );

    return {
        title: pageTitle,
        artist: pageArtist,

        originalKey:
            keyInfo.originalKey,

        shapeKey:
            keyInfo.shapeKey,

        capo:
            keyInfo.capo,

        content:
            cleanSongContent(content),

        url:
            page.finalUrl || url,

        source:
            'cifraclub',

        score
    };
}

// ============================================================
// EXECUTOR CONCORRENTE
// ============================================================

async function runConcurrent(
    items,
    concurrency,
    worker
) {
    const results = [];

    let index = 0;

    async function runner() {
        while (true) {
            const current =
                index++;

            if (current >= items.length) {
                return;
            }

            try {
                const result =
                    await worker(items[current]);

                if (result) {
                    results.push(result);
                }
            } catch (error) {
                // Ignora falha individual
            }
        }
    }

    const workers = [];

    const amount =
        Math.min(
            concurrency,
            items.length
        );

    for (let i = 0; i < amount; i++) {
        workers.push(runner());
    }

    await Promise.all(workers);

    return results;
}

// ============================================================
// BUSCA DIRETA
// ============================================================

async function searchDirect(
    artist,
    track
) {
    const candidates =
        generateDirectCandidates(
            artist,
            track
        );

    console.log(
        `🎯 Candidatos diretos: ${candidates.length}`
    );

    const results =
        await runConcurrent(
            candidates,
            DIRECT_CONCURRENCY,
            async url => {
                const result =
                    await inspectSongUrl(
                        url,
                        artist,
                        track
                    );

                if (result) {
                    console.log(
                        `✅ URL válida: ${result.url}`
                    );
                }

                return result;
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

// ============================================================
// CATÁLOGO DO ARTISTA
// ============================================================

async function fetchArtistCatalog(
    artistSlug
) {
    const cached =
        getCatalogCache(
            artistSlug
        );

    if (cached) {
        return cached;
    }

    const urls = [
        `${CIFRA_BASE}/${artistSlug}/`,
        `${CIFRA_BASE}/${artistSlug}/musicas.html`
    ];

    const links = [];

    for (const url of urls) {
        const page =
            await fetchHtml(url);

        if (!page) continue;

        const $ =
            cheerio.load(page.html);

        $('a[href]').each(
            (index, element) => {
                const href =
                    $(element).attr('href');

                if (!href) return;

                try {
                    const absolute =
                        new URL(
                            href,
                            CIFRA_BASE
                        ).toString();

                    if (
                        isValidCifraClubUrl(
                            absolute
                        )
                    ) {
                        const text =
                            $(element)
                                .text()
                                .replace(/\s+/g, ' ')
                                .trim();

                        links.push({
                            url: absolute,
                            title:
                                cleanLinkTitle(
                                    text,
                                    absolute
                                )
                        });
                    }
                } catch (error) {}
            }
        );
    }

    const unique =
        new Map();

    for (const item of links) {
        const cleanUrl =
            item.url
                .split('?')[0]
                .replace(/\/+$/, '') + '/';

        if (!unique.has(cleanUrl)) {
            unique.set(cleanUrl, {
                url: cleanUrl,
                title: item.title
            });
        }
    }

    const catalog =
        [...unique.values()];

    saveCatalogCache(
        artistSlug,
        catalog
    );

    console.log(
        `📚 Catálogo ${artistSlug}: ${catalog.length} URLs`
    );

    return catalog;
}

// ============================================================
// BUSCA NO CATÁLOGO DO ARTISTA
// ============================================================

async function searchArtistCatalog(
    artist,
    track
) {
    const artistSlugs =
        generateArtistSlugs(
            artist
        );

    const allCandidates = [];

    for (const artistSlug of artistSlugs) {
        const catalog =
            await fetchArtistCatalog(
                artistSlug
            );

        for (const item of catalog) {
            const score =
                scoreSong(
                    artist,
                    track,
                    artist,
                    item.title
                );

            if (score >= 35) {
                allCandidates.push({
                    ...item,
                    score
                });
            }
        }
    }

    const unique =
        new Map();

    for (const item of allCandidates) {
        if (
            !unique.has(item.url) ||
            unique.get(item.url).score <
                item.score
        ) {
            unique.set(
                item.url,
                item
            );
        }
    }

    const ranked =
        [...unique.values()]
            .sort(
                (a, b) =>
                    b.score - a.score
            )
            .slice(0, 15);

    console.log(
        `🏆 Catálogo: ${ranked.length} candidatos`
    );

    if (!ranked.length) {
        return [];
    }

    const results =
        await runConcurrent(
            ranked,
            CATALOG_CONCURRENCY,
            async item => {
                return await inspectSongUrl(
                    item.url,
                    artist,
                    track
                );
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

// ============================================================
// BUSCA INTERNA DO CIFRA CLUB
// ============================================================
// FIX: o site usa caminho com slug (ex: /search/nadson-sinal/), não
// query string (?q=). Confirmei isso testando de verdade contra o
// site antes desta correção — usar ?q= provavelmente caía na página
// genérica de busca, não em resultados da query.

async function searchCifraClub(
    artist,
    track
) {
    const queries = [];

    for (const trackVariant of generateTrackTitleVariants(track)) {
        addUniqueText(queries, trackVariant);

        for (const artistVariant of generateArtistNameVariants(artist)) {
            addUniqueText(
                queries,
                `${trackVariant} ${artistVariant}`
            );

            addUniqueText(
                queries,
                `${artistVariant} ${trackVariant}`
            );
        }
    }

    const links = [];

    for (const query of queries.slice(0, 18)) {
        const slug =
            normalizeText(query)
                .replace(/\s+/g, '-');

        if (!slug) continue;

        try {
            const response =
                await axios.get(
                    `${CIFRA_BASE}/search/${encodeURIComponent(slug)}/`,
                    {
                        timeout:
                            REQUEST_TIMEOUT,
                        headers: HEADERS
                    }
                );

            const $ =
                cheerio.load(
                    response.data
                );

            $('a[href]').each(
                (index, element) => {
                    const href =
                        $(element).attr('href');

                    if (!href) return;

                    try {
                        const absolute =
                            new URL(
                                href,
                                CIFRA_BASE
                            ).toString();

                        if (
                            !isValidCifraClubUrl(
                                absolute
                            )
                        ) {
                            return;
                        }

                        const title =
                            $(element)
                                .text()
                                .replace(/\s+/g, ' ')
                                .trim();

                        links.push({
                            url: absolute,
                            title:
                                cleanLinkTitle(
                                    title,
                                    absolute
                                )
                        });
                    } catch (error) {}
                }
            );
        } catch (error) {
            console.log(
                `⚠️ Busca interna falhou: ${query} (${error.message})`
            );
        }
    }

    const unique =
        new Map();

    for (const item of links) {
        const score =
            scoreSong(
                artist,
                track,
                '',
                item.title
            );

        if (
            !unique.has(item.url) ||
            unique.get(item.url).score <
                score
        ) {
            unique.set(
                item.url,
                {
                    ...item,
                    score
                }
            );
        }
    }

    const ranked =
        [...unique.values()]
            .sort(
                (a, b) =>
                    b.score - a.score
            )
            .slice(0, 15);

    console.log(
        `🔍 Busca interna: ${ranked.length} candidatos válidos`
    );

    const results =
        await runConcurrent(
            ranked,
            SEARCH_CONCURRENCY,
            async item => {
                return await inspectSongUrl(
                    item.url,
                    artist,
                    track
                );
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

// ============================================================
// BUSCA WEB COMO ÚLTIMO RECURSO
// ============================================================

function extractSearchResultUrl(href) {
    if (!href) return '';

    try {
        const parsed =
            new URL(
                href,
                'https://duckduckgo.com'
            );

        const uddg =
            parsed.searchParams.get('uddg');

        if (uddg) {
            return decodeURIComponent(uddg);
        }

        return parsed.toString();
    } catch (error) {
        return '';
    }
}

async function searchWebForCifraClub(
    artist,
    track
) {
    const queries = [];

    for (const trackVariant of generateTrackTitleVariants(track)) {
        addUniqueText(
            queries,
            `site:cifraclub.com.br ${trackVariant}`
        );

        for (const artistVariant of generateArtistNameVariants(artist)) {
            addUniqueText(
                queries,
                `site:cifraclub.com.br ${trackVariant} ${artistVariant}`
            );
        }
    }

    const links = [];

    await runConcurrent(
        queries.slice(
            0,
            CIFRACLUB_WEB_QUERY_LIMIT
        ),
        WEB_QUERY_CONCURRENCY,
        async query => {
            try {
                const response =
                    await axios.get(
                        'https://duckduckgo.com/html/',
                        {
                            timeout:
                                REQUEST_TIMEOUT,
                            headers: HEADERS,
                            params: {
                                q: query
                            }
                        }
                    );

                const $ =
                    cheerio.load(
                        response.data
                    );

                $('a[href]').each(
                    (index, element) => {
                        const href =
                            $(element).attr('href');

                        const absolute =
                            extractSearchResultUrl(
                                href
                            );

                        if (
                            !isValidCifraClubUrl(
                                absolute
                            )
                        ) {
                            return;
                        }

                        const title =
                            $(element)
                                .text()
                                .replace(/\s+/g, ' ')
                                .trim();

                        links.push({
                            url:
                                absolute,
                            title:
                                cleanLinkTitle(
                                    title,
                                    absolute
                                )
                        });
                    }
                );
            } catch (error) {
                console.log(
                    `⚠️ Busca web falhou: ${query} (${error.message})`
                );
            }

            return null;
        }
    );

    const unique =
        new Map();

    for (const item of links) {
        const cleanUrl =
            item.url
                .split('?')[0]
                .replace(/\/+$/, '') + '/';

        const score =
            scoreSong(
                artist,
                track,
                '',
                item.title
            );

        if (
            !unique.has(cleanUrl) ||
            unique.get(cleanUrl).score < score
        ) {
            unique.set(
                cleanUrl,
                {
                    url:
                        cleanUrl,
                    title:
                        item.title,
                    score
                }
            );
        }
    }

    const ranked =
        [...unique.values()]
            .sort(
                (a, b) =>
                    b.score - a.score
            )
            .slice(0, 12);

    console.log(
        `🛟 Busca web: ${ranked.length} candidatos`
    );

    const results =
        await runConcurrent(
            ranked,
            WEB_SEARCH_CONCURRENCY,
            async item => {
                return await inspectSongUrl(
                    item.url,
                    artist,
                    track
                );
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

// ============================================================
// BUSCA EM PROVEDORES ALTERNATIVOS
// ============================================================

async function inspectAlternativeProviderUrl(
    url,
    provider,
    requestedArtist,
    requestedTrack
) {
    if (
        !isValidAlternativeProviderUrl(
            provider,
            url
        )
    ) {
        return null;
    }

    const page =
        await fetchHtml(url);

    if (!page) {
        return null;
    }

    const $ =
        cheerio.load(page.html);

    const content =
        extractAlternativeProviderContent(
            $,
            provider
        );

    if (!looksLikeChordContent(content)) {
        return null;
    }

    const metadata =
        extractAlternativeProviderMetadata(
            $,
            provider,
            page.finalUrl || url,
            requestedArtist
        );

    const pageTitle =
        metadata.title || requestedTrack;

    const pageArtist =
        metadata.artist || requestedArtist;

    const score =
        scoreSong(
            requestedArtist,
            requestedTrack,
            pageArtist,
            pageTitle
        );

    if (
        score < 50 ||
        !hasSafeTitleMatch(
            requestedTrack,
            pageTitle
        ) ||
        !hasCompositeTrackCoverage(
            requestedTrack,
            pageTitle,
            content
        )
    ) {
        return null;
    }

    const keyInfo =
        extractKeyInfo(
            $,
            content
        );

    return {
        title:
            pageTitle,

        artist:
            pageArtist,

        originalKey:
            keyInfo.originalKey,

        shapeKey:
            keyInfo.shapeKey,

        capo:
            keyInfo.capo,

        content:
            cleanSongContent(content),

        url:
            page.finalUrl || url,

        source:
            provider.source,

        score
    };
}

async function searchAlternativeProvidersDirect(
    artist,
    track
) {
    const candidates = [];

    for (const provider of ALTERNATIVE_CIFRA_PROVIDERS) {
        const artistSlugs =
            generateArtistSlugs(artist);

        const trackSlugs =
            generateTrackSlugs(track);

        for (const artistSlug of artistSlugs) {
            for (const trackSlug of trackSlugs) {
                candidates.push({
                    provider,
                    url:
                        buildAlternativeProviderUrl(
                            provider,
                            artistSlug,
                            trackSlug
                        )
                });
            }
        }
    }

    const unique =
        new Map();

    for (const item of candidates) {
        const key =
            `${item.provider.source}:${item.url}`;

        if (!unique.has(key)) {
            unique.set(key, item);
        }
    }

    const items =
        [...unique.values()];

    console.log(
        `🧭 Provedores alternativos diretos: ${items.length} candidatos`
    );

    const results =
        await runConcurrent(
            items,
            DIRECT_CONCURRENCY,
            async item => {
                const result =
                    await inspectAlternativeProviderUrl(
                        item.url,
                        item.provider,
                        artist,
                        track
                    );

                if (result) {
                    console.log(
                        `✅ Alternativo válido (${item.provider.label}): ${result.url}`
                    );
                }

                return result;
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

async function searchWebForAlternativeProviders(
    artist,
    track
) {
    const queries = [];

    for (const provider of ALTERNATIVE_CIFRA_PROVIDERS) {
        for (const trackVariant of generateTrackTitleVariants(track)) {
            addUniqueText(
                queries,
                `site:${provider.searchDomain} ${trackVariant}`
            );

            for (const artistVariant of generateArtistNameVariants(artist)) {
                addUniqueText(
                    queries,
                    `site:${provider.searchDomain} ${trackVariant} ${artistVariant}`
                );
            }
        }
    }

    const links = [];

    await runConcurrent(
        queries.slice(
            0,
            ALTERNATIVE_WEB_QUERY_LIMIT
        ),
        WEB_QUERY_CONCURRENCY,
        async query => {
            try {
                const response =
                    await axios.get(
                        'https://duckduckgo.com/html/',
                        {
                            timeout:
                                REQUEST_TIMEOUT,
                            headers: HEADERS,
                            params: {
                                q: query
                            }
                        }
                    );

                const $ =
                    cheerio.load(response.data);

                $('a[href]').each(
                    (index, element) => {
                        const href =
                            $(element).attr('href');

                        const absolute =
                            extractSearchResultUrl(href);

                        const provider =
                            alternativeProviderForUrl(
                                absolute
                            );

                        if (!provider) {
                            return;
                        }

                        const title =
                            $(element)
                                .text()
                                .replace(/\s+/g, ' ')
                                .trim();

                        links.push({
                            provider,
                            url:
                                absolute,
                            title:
                                cleanAlternativeLinkTitle(
                                    title,
                                    absolute
                                )
                        });
                    }
                );
            } catch (error) {
                console.log(
                    `⚠️ Busca web alternativa falhou: ${query} (${error.message})`
                );
            }

            return null;
        }
    );

    const unique =
        new Map();

    for (const item of links) {
        const cleanUrl =
            item.url
                .split('?')[0]
                .replace(/\/+$/, '') + '/';

        const score =
            scoreSong(
                artist,
                track,
                '',
                item.title
            );

        const key =
            `${item.provider.source}:${cleanUrl}`;

        if (
            !unique.has(key) ||
            unique.get(key).score < score
        ) {
            unique.set(
                key,
                {
                    provider:
                        item.provider,
                    url:
                        cleanUrl,
                    title:
                        item.title,
                    score
                }
            );
        }
    }

    const ranked =
        [...unique.values()]
            .sort(
                (a, b) =>
                    b.score - a.score
            )
            .slice(0, 16);

    console.log(
        `🛟 Busca web alternativa: ${ranked.length} candidatos`
    );

    const results =
        await runConcurrent(
            ranked,
            WEB_SEARCH_CONCURRENCY,
            async item => {
                return await inspectAlternativeProviderUrl(
                    item.url,
                    item.provider,
                    artist,
                    track
                );
            }
        );

    return results.sort(
        (a, b) =>
            b.score - a.score
    );
}

// ============================================================
// ESCOLHER MELHOR RESULTADO
// ============================================================

function chooseBestResult(
    results
) {
    if (!results.length) {
        return null;
    }

    const sorted =
        [...results].sort(
            (a, b) =>
                b.score - a.score
        );

    return sorted[0];
}

function summarizeSearchCandidates(results) {
    return [...results]
        .sort(
            (a, b) =>
                (b.score || 0) - (a.score || 0)
        )
        .slice(0, 5)
        .map(item => ({
            title:
                String(item.title || '').slice(0, 120),
            artist:
                String(item.artist || '').slice(0, 120),
            source:
                String(item.source || '').slice(0, 60),
            url:
                String(item.url || '').slice(0, 240),
            score:
                Math.round(item.score || 0)
        }));
}

function buildSongSearchError({
    artist,
    track,
    reason,
    message,
    allResults = [],
    checkedSources = []
}) {
    const candidates =
        summarizeSearchCandidates(allResults);

    const reasonMessages = {
        medley_not_found:
            'Não encontrei uma cifra completa desse medley nas fontes disponíveis. Para evitar cifra pela metade, não abri resultado parcial.',
        no_reliable_match:
            'Encontrei resultados parecidos, mas nenhum bateu com segurança com esse artista e essa música.',
        no_published_chord:
            'Não encontrei cifra publicada para esse artista e essa música nas fontes atuais.',
        search_failed:
            'A busca falhou antes de terminar. Tente novamente em alguns instantes.'
    };

    return {
        code: 'SONG_NOT_FOUND',
        statusCode: 404,
        reason,
        message:
            message ||
            reasonMessages[reason] ||
            reasonMessages.no_published_chord,
        userMessage:
            reasonMessages[reason] ||
            reasonMessages.no_published_chord,
        diagnostics: {
            artist,
            track,
            normalizedArtist:
                normalizeText(artist),
            normalizedTrack:
                normalizeText(track),
            checkedSources,
            candidateCount:
                allResults.length,
            topCandidates:
                candidates
        }
    };
}

function throwSongSearchError(options) {
    const payload =
        buildSongSearchError(options);
    throw Object.assign(
        new Error(payload.message),
        payload
    );
}

function searchErrorResponse(error, artist, track) {
    if (error.code !== 'SONG_NOT_FOUND') {
        return {
            error:
                error.code ||
                'server_error',
            reason:
                'search_failed',
            message:
                error.message ||
                'Falha interna ao buscar cifra.',
            userMessage:
                'Não consegui terminar a busca agora. Tente novamente em alguns instantes.',
            diagnostics: {
                artist,
                track,
                normalizedArtist:
                    normalizeText(artist),
                normalizedTrack:
                    normalizeText(track)
            }
        };
    }

    const fallback =
        buildSongSearchError({
            artist,
            track,
            reason:
                error.reason ||
                (error.code === 'SONG_NOT_FOUND'
                    ? 'no_published_chord'
                    : 'search_failed'),
            message:
                error.message
        });

    return {
        error:
            error.code ||
            fallback.code ||
            'server_error',
        reason:
            error.reason ||
            fallback.reason,
        message:
            error.message ||
            fallback.message,
        userMessage:
            error.userMessage ||
            fallback.userMessage,
        diagnostics:
            error.diagnostics ||
            fallback.diagnostics
    };
}

// ============================================================
// BUSCA PRINCIPAL
// ============================================================

async function findSong(
    artist,
    track
) {
    console.log('');
    console.log(
        '══════════════════════════════════════'
    );
    console.log(
        '🎸 CIFRA BAND — BUSCA INTELIGENTE V5'
    );
    console.log(
        '══════════════════════════════════════'
    );

    console.log(
        `🎤 Artista: ${artist}`
    );

    console.log(
        `🎵 Música: ${track}`
    );

    // ========================================================
    // 1. DIRETA
    // ========================================================

    console.log('');
    console.log(
        '1️⃣ TESTANDO URLs DIRETAS...'
    );

    // FIX: acumula os resultados de TODAS as etapas aqui. Antes,
    // "results" era reatribuída a cada etapa e a etapa 4 só enxergava
    // o que a etapa 3 tinha achado — qualquer candidato válido, mas
    // com score abaixo do limiar de aceite imediato de uma etapa
    // anterior, era descartado pra sempre em vez de virar fallback.
    const allResults = [];
    const checkedSources = [
        'cifraclub_direct',
        'cifraclub_artist_catalog',
        'cifraclub_internal_search',
        'alternative_direct',
        'cifraclub_web_search',
        'alternative_web_search'
    ];

    let results =
        await searchDirect(
            artist,
            track
        );

    allResults.push(...results);

    let best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 90
    ) {
        console.log(
            `🏆 Encontrada pela URL direta`
        );

        return best;
    }

    // ========================================================
    // 2. CATÁLOGO DO ARTISTA
    // ========================================================

    console.log('');
    console.log(
        '2️⃣ CONSULTANDO CATÁLOGO DO ARTISTA...'
    );

    results =
        await searchArtistCatalog(
            artist,
            track
        );

    allResults.push(...results);

    best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 70
    ) {
        console.log(
            `🏆 Encontrada no catálogo do artista`
        );

        return best;
    }

    // ========================================================
    // 3. BUSCA INTERNA
    // ========================================================

    console.log('');
    console.log(
        '3️⃣ BUSCA INTERNA DO CIFRA CLUB...'
    );

    results =
        await searchCifraClub(
            artist,
            track
        );

    allResults.push(...results);

    best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 65
    ) {
        console.log(
            `🏆 Encontrada pela busca interna`
        );

        return best;
    }

    // ========================================================
    // 4. PROVEDORES ALTERNATIVOS POR URL DIRETA
    // ========================================================

    console.log('');
    console.log(
        '4️⃣ TESTANDO PROVEDORES ALTERNATIVOS...'
    );

    results =
        await searchAlternativeProvidersDirect(
            artist,
            track
        );

    allResults.push(...results);

    best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 90
    ) {
        console.log(
            `🏆 Encontrada em provedor alternativo direto`
        );

        return best;
    }

    if (compositeTrackParts(track).length > 1) {
        console.log(
            '🧩 Medley/composição não encontrada como cifra completa; pulando busca web ampla para evitar resultado parcial.'
        );

        throwSongSearchError({
            artist,
            track,
            reason: 'medley_not_found',
            allResults,
            checkedSources:
                checkedSources.slice(0, 4)
        });
    }

    // ========================================================
    // 5. BUSCA WEB COMO ÚLTIMO RECURSO NO CIFRA CLUB
    // ========================================================

    console.log('');
    console.log(
        '5️⃣ BUSCA WEB POR LINKS DO CIFRA CLUB...'
    );

    results =
        await searchWebForCifraClub(
            artist,
            track
        );

    allResults.push(...results);

    best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 70
    ) {
        console.log(
            `🏆 Encontrada pela busca web`
        );

        return best;
    }

    // ========================================================
    // 6. BUSCA WEB EM PROVEDORES ALTERNATIVOS
    // ========================================================

    console.log('');
    console.log(
        '6️⃣ BUSCA WEB EM PROVEDORES ALTERNATIVOS...'
    );

    results =
        await searchWebForAlternativeProviders(
            artist,
            track
        );

    allResults.push(...results);

    best =
        chooseBestResult(
            results
        );

    if (
        best &&
        best.score >= 75
    ) {
        console.log(
            `🏆 Encontrada pela busca web alternativa`
        );

        return best;
    }

    // ========================================================
    // 7. ÚLTIMA TENTATIVA
    // ========================================================

    console.log('');
    console.log(
        `7️⃣ ÚLTIMA TENTATIVA COM TODOS OS RESULTADOS (${allResults.length} ao todo)...`
    );

    best =
        chooseBestResult(
            allResults
        );

    if (
        best &&
        best.score >= 55
    ) {
        console.log(
            `⚠️ Resultado aceito com score ${best.score.toFixed(1)}`
        );

        return best;
    }

    throwSongSearchError({
        artist,
        track,
        reason:
            allResults.length
                ? 'no_reliable_match'
                : 'no_published_chord',
        allResults,
        checkedSources
    });
}

// ============================================================
// ENDPOINT
// ============================================================

// FIX (rede de segurança): algumas chamadas estão chegando com o
// nome do artista duplicado dentro do campo track, tipo
// "Aline Barros - Dança do Pinguim" em vez de só "Dança do Pinguim".
// Isso confunde geração de slug e pontuação de similaridade. O ideal
// é achar de onde isso vem no app Flutter e corrigir na origem —
// mas aqui a gente corta o prefixo se ele bater com o artista
// informado, pra não depender só disso.
function stripDuplicatedArtistPrefix(artist, track) {
    const cleanArtist = String(artist || '').trim();
    const cleanTrack = String(track || '').trim();

    if (!cleanArtist || !cleanTrack) {
        return cleanTrack;
    }

    const escaped = cleanArtist.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
    );

    const prefixPattern = new RegExp(
        `^${escaped}\\s*[-:]\\s*`,
        'i'
    );

    if (prefixPattern.test(cleanTrack)) {
        const stripped =
            cleanTrack
                .replace(prefixPattern, '')
                .trim();

        if (stripped) {
            console.log(
                `🧹 Prefixo de artista removido do track: "${cleanTrack}" -> "${stripped}"`
            );
            return stripped;
        }
    }

    return cleanTrack;
}

app.get(
    '/searchSong',
    authenticateFirebaseUser,
    rateLimit({
        name: 'searchSong',
        windowMs: SEARCH_RATE_LIMIT_WINDOW_MS,
        max: SEARCH_RATE_LIMIT_MAX
    }),
    async (req, res) => {
        const artist =
            String(
                req.query.artist || ''
            ).trim();

        const track = stripDuplicatedArtistPrefix(
            artist,
            String(
                req.query.track || ''
            ).trim()
        );

        if (!artist || !track) {
            return res.status(400).json({
                error:
                    'missing_parameters',

                message:
                    'Informe artist e track.'
            });
        }

        const cacheKey =
            `${normalizeText(artist)}::${normalizeText(track)}`;

        // ====================================================
        // CACHE
        // ====================================================

        const cached =
            getSongCache(
                cacheKey
            );

        if (cached) {
            console.log(
                `⚡ CACHE: ${artist} - ${track}`
            );

            return res
                .status(200)
                .json(cached);
        }

        const globalCached =
            await getGlobalSongCache(
                artist,
                track
            );

        if (globalCached) {
            console.log(
                `⚡ CACHE GLOBAL: ${artist} - ${track}`
            );

            return res
                .status(200)
                .json(globalCached);
        }

        // ====================================================
        // EVITAR BUSCAS DUPLICADAS
        // ====================================================

        if (
            inFlight.has(cacheKey)
        ) {
            try {
                const result =
                    await inFlight.get(
                        cacheKey
                    );

                return res
                    .status(200)
                    .json(result);
            } catch (error) {
                const payload =
                    searchErrorResponse(
                        error,
                        artist,
                        track
                    );

                return res
                    .status(
                        error.statusCode ||
                            500
                    )
                    .json(payload);
            }
        }

        // ====================================================
        // EXECUTAR BUSCA
        // ====================================================

        const promise =
            (async () => {
                const result =
                    await findSong(
                        artist,
                        track
                    );

                const response = repairSongKeyInfo({
                    title:
                        result.title ||
                        track,

                    artist:
                        result.artist ||
                        artist,

                    originalKey:
                        result.originalKey ||
                        '',

                    shapeKey:
                        result.shapeKey ||
                        '',

                    capo:
                        result.capo ||
                        '',

                    content:
                        result.content,

                    url:
                        result.url,

                    source:
                        result.source,

                    // útil para debug
                    searchScore:
                        Math.round(
                            result.score
                        )
                });

                saveSongCache(
                    cacheKey,
                    response
                );

                await saveGlobalSongCache(
                    artist,
                    track,
                    response
                );

                return response;
            })();

        inFlight.set(
            cacheKey,
            promise
        );

        try {
            const result =
                await promise;

            console.log('');
            console.log(
                '══════════════════════════════════════'
            );

            console.log(
                '✅ CIFRA ENCONTRADA'
            );

            console.log(
                `🎵 ${result.title}`
            );

            console.log(
                `🎤 ${result.artist}`
            );

            console.log(
                `🎼 Tom: ${
                    result.originalKey ||
                    'não identificado'
                }`
            );

            console.log(
                `🎸 Forma: ${
                    result.shapeKey ||
                    'não identificada'
                }`
            );

            console.log(
                `🪕 Capo: ${
                    result.capo
                        ? result.capo + 'ª casa'
                        : 'sem capo'
                }`
            );

            console.log(
                `🎯 Score: ${result.searchScore}`
            );

            console.log(
                `🔗 ${result.url}`
            );

            console.log(
                '══════════════════════════════════════'
            );

            return res
                .status(200)
                .json(result);

        } catch (error) {
            console.log('');
            console.log(
                '══════════════════════════════════════'
            );

            console.log(
                '❌ ERRO NA BUSCA'
            );

            console.log(
                `🎤 ${artist}`
            );

            console.log(
                `🎵 ${track}`
            );

            console.log(
                `❌ ${error.message}`
            );

            console.log(
                '══════════════════════════════════════'
            );

            const payload =
                searchErrorResponse(
                    error,
                    artist,
                    track
                );

            return res
                .status(
                    error.statusCode ||
                        500
                )
                .json(payload);
        } finally {
            inFlight.delete(
                cacheKey
            );
        }
    }
);

// ============================================================
// SERVER
// ============================================================

app.listen(
    port,
    () => {
        console.log(
            `🚀 Cifra Band API V5-Intelligent rodando na porta ${port}`
        );
    }
);
