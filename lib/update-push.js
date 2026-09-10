const { createHash, randomUUID } = require('node:crypto');
const PAGE_SIZE = 100;
const LEASE_MS = 5 * 60 * 1000;
const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const invalidTokenCodes = new Set(['messaging/invalid-registration-token', 'messaging/registration-token-not-registered']);

function deviceId(token) {
    return createHash('sha256').update(token).digest('hex');
}

function isEligible(device, version) {
    return device.platform === 'android' && device.enabled !== false &&
        Number.isSafeInteger(device.build) && device.build > 0 &&
        device.build < version.latestBuild &&
        (device.lastNotifiedBuild || 0) < version.latestBuild &&
        typeof device.token === 'string' && device.token.length > 0;
}

function notificationPayload(tokens, version) {
    return {
        tokens,
        notification: { title: 'Nova atualização do Cifra Band',
            body: `A versão ${version.latestVersion} está disponível. Toque para atualizar pelo app.` },
        data: { type: 'app_update_available', latestBuild: String(version.latestBuild) },
        android: { priority: 'high', ttl: 24 * 60 * 60 * 1000,
            notification: { channelId: 'cifra_band_alerts', tag: 'cifra-band-update' } },
    };
}

function createUpdatePushWorker({ getAdmin, getVersion, now = Date.now, logger = console }) {
    let running = false;
    let nextCheck = 0;
    let checkedBuild = 0;
    async function runPage() {
        const version = getVersion();
        if (!version.apkUrl || !Number.isSafeInteger(version.latestBuild) || version.latestBuild <= 0) return false;
        const admin = getAdmin();
        if (!admin) return false;
        const db = admin.firestore();
        const stateRef = db.collection('system_jobs').doc('app_update_push');
        const owner = randomUUID();
        const claim = await db.runTransaction(async tx => {
            const snapshot = await tx.get(stateRef);
            const state = snapshot.data() || {};
            if ((state.leaseUntil || 0) > now()) return null;
            if (state.build === version.latestBuild && (state.nextRunAt || 0) > now()) return null;
            const cursor = state.build === version.latestBuild ? state.cursor || null : null;
            tx.set(stateRef, { build: version.latestBuild, cursor, owner, leaseUntil: now() + LEASE_MS }, { merge: true });
            return { cursor };
        });
        if (!claim) return false;
        try {
            let query = db.collection('app_devices').orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
            if (claim.cursor) query = query.startAfter(claim.cursor);
            const page = await query.get();
            const targets = page.docs.filter(doc => isEligible(doc.data(), version));
            if (targets.length) {
                const result = await admin.messaging().sendEachForMulticast(
                    notificationPayload(targets.map(doc => doc.data().token), version));
                const batch = db.batch();
                result.responses.forEach((response, index) => {
                    const ref = targets[index].ref;
                    if (response.success) batch.update(ref, { lastNotifiedBuild: version.latestBuild, notifiedAt: now(), lastPushError: null });
                    else if (invalidTokenCodes.has(response.error?.code)) batch.update(ref, { enabled: false, lastPushError: response.error.code });
                    else batch.update(ref, { lastPushError: response.error?.code || 'send_failed' });
                });
                await batch.commit();
                logger.log('Update push', { build: version.latestBuild, sent: result.successCount, failed: result.failureCount });
            }
            const more = page.size === PAGE_SIZE;
            await db.runTransaction(async tx => {
                const state = (await tx.get(stateRef)).data();
                if (state?.owner !== owner) return;
                tx.update(stateRef, { leaseUntil: 0, cursor: more ? page.docs.at(-1).id : null,
                    nextRunAt: more ? 0 : now() + SCAN_INTERVAL_MS, finishedAt: now() });
            });
            return more;
        } catch (error) {
            await db.runTransaction(async tx => {
                const state = (await tx.get(stateRef)).data();
                if (state?.owner === owner) tx.update(stateRef, { leaseUntil: 0, nextRunAt: now() + 60_000 });
            }).catch(() => {});
            throw error;
        }
    }
    function kick() {
        const build = getVersion().latestBuild;
        if (running || (checkedBuild === build && now() < nextCheck)) return;
        running = true;
        checkedBuild = build;
        nextCheck = now() + 60_000;
        runPage().then(more => {
            if (more) {
                nextCheck = 0;
                setTimeout(kick, 1000).unref();
            }
        }).catch(error => logger.error('Update push failed:', error.code || error.message))
            .finally(() => { running = false; });
    }
    return { kick, runPage };
}

function parseRegistration(body) {
    if (!body || typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 4096 ||
        !Number.isSafeInteger(body.build) || body.build <= 0 || body.build > 2147483647 ||
        body.platform !== 'android') return null;
    return { token: body.token, build: body.build, platform: 'android' };
}

module.exports = { createUpdatePushWorker, isEligible, notificationPayload, deviceId, parseRegistration };
