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
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

const NOTIFICATION_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const NOTIFICATION_RATE_LIMIT_MAX = 30;
const SEARCH_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const SEARCH_RATE_LIMIT_MAX = 60;
const rateLimitBuckets = new Map();

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
    'tu', 'eu', 'teu', 'tua', 'meu', 'minha', 'seu', 'sua',
    'nosso', 'nossa', 'es', 'sou', 'sao', 'foi', 'esta'
]);

function significantTokens(text) {
    return tokenize(text).filter(
        token =>
            !GENERIC_WORDS.has(token) &&
            !STOPWORDS.has(token)
    );
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

    add(formatArtistSlug(original));
    add(normalized);

    // Heurística geral (além do alias específico acima): vários artistas
    // "de nome composto" no Cifra Club usam só a primeira palavra como
    // slug — foi exatamente o caso do "nadson o ferinha" -> "nadson".
    // Custa pouco tentar, e a validação por score protege contra pegar
    // o artista errado por engano.
    const firstWord = normalized.split(' ')[0];
    if (firstWord && firstWord.length > 2) {
        add(firstWord);
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

    const base = basicTrackSlug(track);

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

    if (score < 45) {
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
                            title: text
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
    const queries = [
        `${track} ${artist}`,
        `${artist} ${track}`,
        track
    ];

    const links = [];

    for (const query of queries) {
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
                            title
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
    // 4. ÚLTIMA TENTATIVA
    // ========================================================

    console.log('');
    console.log(
        `4️⃣ ÚLTIMA TENTATIVA COM TODOS OS RESULTADOS (${allResults.length} ao todo)...`
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

    throw Object.assign(
        new Error(
            'Cifra não encontrada no Cifra Club.'
        ),
        {
            code: 'SONG_NOT_FOUND',
            statusCode: 404
        }
    );
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
                return res
                    .status(
                        error.statusCode ||
                            500
                    )
                    .json({
                        error:
                            error.code ||
                            'server_error',

                        message:
                            error.message
                    });
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

            return res
                .status(
                    error.statusCode ||
                        500
                )
                .json({
                    error:
                        error.code ||
                        'server_error',

                    message:
                        error.message
                });
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
