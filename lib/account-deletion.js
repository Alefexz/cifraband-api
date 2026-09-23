const {createHash, randomUUID} = require('node:crypto');
const path = require('node:path');
const {activeRequestsFor} = require('./firebase-auth');
const PAGE = 100;
const LEASE_MS = 5 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const receiptPattern = /^[a-f0-9]{64}$/;
const receiptId = receipt => createHash('sha256').update(receipt).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const phases = ['freeze', 'profiles', 'setlists', 'schedules', 'ministries', 'support', 'devices', 'contacts', 'legacySongs', 'orphanRehearsals', 'orphanVersions', 'orphanSongs', 'orphanOfficialSongs', 'finish'];

function cleanSchedule(data, uid) {
    const cleanSongs = songs => (Array.isArray(songs) ? songs : [])
        .filter(song => song.suggestedByUid !== uid && song.created_by !== uid)
        .map(song => ({...song,
            ...(Array.isArray(song.upvotes) ? {upvotes: song.upvotes.filter(id => id !== uid)} : {}),
            ...(Array.isArray(song.downvotes) ? {downvotes: song.downvotes.filter(id => id !== uid)} : {}),
        }));
    return {
        ...(Array.isArray(data.team_assignments) ? {team_assignments: data.team_assignments.filter(item => item.uid !== uid)} : {}),
        ...(Array.isArray(data.team_uids) ? {team_uids: data.team_uids.filter(id => id !== uid)} : {}),
        ...(Array.isArray(data.approved_songs) ? {approved_songs: cleanSongs(data.approved_songs)} : {}),
        ...(Array.isArray(data.suggested_songs) ? {suggested_songs: cleanSongs(data.suggested_songs)} : {}),
    };
}

function createAccountDeletionService({getAdmin, now = Date.now, logger = console}) {
    let running = false;
    const db = () => getAdmin().firestore();
    const fv = () => getAdmin().firestore.FieldValue;
    async function options(uid) {
        const ministries = await db().collection('ministries').where('admin_id', '==', uid).get();
        const result = [];
        for (const ministry of ministries.docs) {
            const members = await db().collection('users').where('church_id', '==', ministry.id).get();
            result.push({id: ministry.id, name: ministry.data().name || 'Ministerio',
                members: members.docs.filter(doc => doc.id !== uid && !doc.data().deletion_pending)
                    .map(doc => ({uid: doc.id, name: doc.data().name || 'Integrante'}))});
        }
        return result;
    }

    async function request(user, body) {
        const uid = user.uid;
        if (body?.confirm !== true || !receiptPattern.test(body.receipt || '')) fail('Confirmacao e protocolo validos sao obrigatorios.');
        if (!Number.isFinite(user.auth_time) || now() / 1000 - user.auth_time > 300 || user.auth_time > now() / 1000 + 60) {
            fail('Entre novamente para confirmar a exclusao.', 401);
        }
        const id = receiptId(body.receipt);
        const job = db().collection('account_deletions').doc(id);
        const block = db().collection('account_deletion_blocks').doc(uid);
        const successors = body.successors && typeof body.successors === 'object' ? body.successors : {};
        await db().runTransaction(async tx => {
            const previous = await tx.get(job);
            const blocked = await tx.get(block);
            if (previous.exists) {
                if (previous.data().uid !== uid) fail('Protocolo indisponivel.', 409);
                return;
            }
            if (blocked.exists) fail('Ja existe uma exclusao solicitada para esta conta.', 409);
            const ministries = await tx.get(db().collection('ministries').where('admin_id', '==', uid));
            const transfers = [];
            const emptyMinistries = [];
            for (const ministry of ministries.docs) {
                const members = await tx.get(db().collection('users').where('church_id', '==', ministry.id));
                const others = members.docs.filter(doc => doc.id !== uid);
                if (!others.length) { emptyMinistries.push(ministry.id); continue; }
                const successor = others.find(doc => doc.id === successors[ministry.id]);
                if (!successor || successor.data().deletion_pending) fail('Escolha um sucessor do proprio ministerio antes de excluir a conta.', 409);
                const deleting = await tx.get(db().collection('account_deletion_blocks').doc(successor.id));
                if (deleting.exists) fail('O sucessor escolhido esta excluindo sua conta.', 409);
                const invites = await tx.get(db().collection('ministry_invites').where('ministry_id', '==', ministry.id));
                transfers.push({ministry, successor, invites});
            }
            // All reads precede writes. The deletion block is atomic with ownership transfer.
            for (const {ministry, successor, invites} of transfers) {
                tx.update(ministry.ref, {admin_id: successor.id});
                tx.update(successor.ref, {is_admin: true});
                for (const invite of invites.docs) tx.update(invite.ref, {admin_id: successor.id});
            }
            for (const ministryId of emptyMinistries) tx.update(db().collection('ministries').doc(ministryId), {deletion_pending: true});
            tx.set(job, {uid, status: 'queued', phase: 'freeze', phaseIndex: 0, cursor: null,
                emptyMinistries, requestedAt: now(), leaseUntil: 0, attempts: 0});
            tx.set(block, {jobId: id, requestedAt: now()});
        });
        return {accepted: true, status: 'queued', receipt: body.receipt};
    }

    async function status(receipt) {
        if (!receiptPattern.test(receipt || '')) fail('Protocolo invalido.');
        const doc = await db().collection('account_deletions').doc(receiptId(receipt)).get();
        if (!doc.exists) fail('Solicitacao nao encontrada.', 404);
        const data = doc.data();
        return {status: data.status, phase: data.phase, requestedAt: data.requestedAt,
            ...(data.completedAt ? {completedAt: data.completedAt} : {})};
    }

    async function authAction(action) {
        try { await action(); } catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
    }
    async function mutate(ref, transform) {
        await db().runTransaction(async tx => {
            const current = await tx.get(ref);
            if (!current.exists) return;
            const patch = transform(current.data());
            if (patch && Object.keys(patch).length) tx.update(ref, patch);
        });
    }
    async function deleteMatches(collection, field, uid) {
        while (true) {
            const page = await collection.where(field, '==', uid).limit(PAGE).get();
            if (page.empty) return;
            for (const doc of page.docs) await db().recursiveDelete(doc.ref);
        }
    }

    async function processDocument(phase, doc, uid) {
        const data = doc.data();
        if (phase === 'profiles') {
            if (doc.id === uid) await db().recursiveDelete(doc.ref);
            else if (data.friends?.includes(uid)) await doc.ref.update({friends: fv().arrayRemove(uid)});
        } else if (phase === 'setlists') {
            if (data.ownerId === uid) { await db().recursiveDelete(doc.ref); return; }
            await mutate(doc.ref, current => ({sharedWith: (current.sharedWith || []).filter(id => id !== uid)}));
            const contributions = await doc.ref.collection('songs').where('created_by', '==', uid).get();
            for (const song of contributions.docs) {
                await db().recursiveDelete(song.ref);
                await doc.ref.update({songIds: fv().arrayRemove(song.id)});
            }
        } else if (phase === 'schedules') {
            await mutate(doc.ref, current => cleanSchedule(current, uid));
            await deleteMatches(doc.ref.collection('rehearsal_status'), 'uid', uid);
        } else if (phase === 'ministries') {
            // Preserve the ministry and other people's work; remove attributable contributions.
            await deleteMatches(doc.ref.collection('official_songs'), 'created_by', uid);
            const songs = await doc.ref.collection('official_songs').get();
            for (const song of songs.docs) {
                await deleteMatches(song.ref.collection('versions'), 'updated_by', uid);
                if (song.data().updated_by === uid) await song.ref.update({updated_by: fv().delete()});
            }
        } else if (phase === 'support') {
            if (data.user?.uid === uid) { await db().recursiveDelete(doc.ref); return; }
            await mutate(doc.ref, current => ({
                ...(Array.isArray(current.messages) ? {messages: current.messages.filter(item => item.uid !== uid)} : {}),
                ...(current.admin_reply?.responder_uid === uid ? {admin_reply: fv().delete()} : {}),
                ...(current.handled_by?.uid === uid ? {handled_by: fv().delete()} : {}),
            }));
        } else if (phase === 'devices' || phase === 'contacts') {
            if (data.uid === uid) await db().recursiveDelete(doc.ref);
        } else if (phase === 'orphanRehearsals') {
            if (data.uid === uid) await db().recursiveDelete(doc.ref);
        } else if (phase === 'orphanVersions') {
            if (data.created_by === uid || data.updated_by === uid) await db().recursiveDelete(doc.ref);
        } else if (phase === 'orphanOfficialSongs') {
            if (data.created_by === uid) await db().recursiveDelete(doc.ref);
            else if (data.updated_by === uid) await doc.ref.update({updated_by: fv().delete()});
        } else if (phase === 'legacySongs' || phase === 'orphanSongs') {
            if ([data.created_by, data.ownerId, data.uid, data.userId].includes(uid)) await db().recursiveDelete(doc.ref);
        }
    }

    async function run(id) {
        const ref = db().collection('account_deletions').doc(id);
        const owner = randomUUID();
        const claimed = await db().runTransaction(async tx => {
            const job = (await tx.get(ref)).data();
            if (!job || job.status === 'complete' || job.leaseUntil > now()) return null;
            tx.update(ref, {status: 'running', owner, leaseUntil: now() + LEASE_MS, attempts: (job.attempts || 0) + 1});
            return job;
        });
        if (!claimed) return false;
        const uid = claimed.uid;
        const progress = async patch => db().runTransaction(async tx => {
            const current = (await tx.get(ref)).data();
            if (current?.owner !== owner) throw new Error('deletion_lease_lost');
            tx.update(ref, {...patch, leaseUntil: now() + LEASE_MS});
        });
        try {
            for (let index = claimed.phaseIndex || 0; index < phases.length; index++) {
                const phase = phases[index];
                await progress({phase, phaseIndex: index});
                if (phase === 'freeze') {
                    await authAction(() => getAdmin().auth().updateUser(uid, {disabled: true}));
                    await authAction(() => getAdmin().auth().revokeRefreshTokens(uid));
                    // Drain requests already admitted by this API instance before
                    // scanning, so they cannot recreate data after its deletion.
                    while (activeRequestsFor(uid) > 0) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        await progress({});
                    }
                } else if (phase === 'finish') {
                    for (const ministryId of claimed.emptyMinistries || []) {
                        const members = await db().collection('users').where('church_id', '==', ministryId).limit(1).get();
                        if (members.empty) {
                            await db().recursiveDelete(db().collection('ministries').doc(ministryId));
                            await deleteMatches(db().collection('schedules'), 'church_id', ministryId);
                            await deleteMatches(db().collection('ministry_invites'), 'ministry_id', ministryId);
                        }
                    }
                    await db().recursiveDelete(db().collection('users').doc(uid));
                    await db().recursiveDelete(db().collection('public_profiles').doc(uid));
                    await authAction(() => getAdmin().auth().deleteUser(uid));
                    const expiresAt = getAdmin().firestore.Timestamp.fromMillis(now() + RETENTION_MS);
                    await db().collection('account_deletion_blocks').doc(uid).set({completedAt: now(), expiresAt});
                    await progress({status: 'complete', phase: 'complete', completedAt: now(),
                        expiresAt, uid: fv().delete(), emptyMinistries: fv().delete()});
                } else {
                    const collection = {profiles: 'users', setlists: 'setlists', schedules: 'schedules',
                        ministries: 'ministries', support: 'support_tickets', devices: 'app_devices',
                        contacts: 'contact_codes', legacySongs: 'songs', orphanRehearsals: 'rehearsal_status',
                        orphanVersions: 'versions', orphanSongs: 'songs', orphanOfficialSongs: 'official_songs'}[phase];
                    let cursor = index === claimed.phaseIndex ? claimed.cursor : null;
                    while (true) {
                        let query = (phase.startsWith('orphan') ? db().collectionGroup(collection) : db().collection(collection))
                            .orderBy(getAdmin().firestore.FieldPath.documentId()).limit(PAGE);
                        if (cursor) query = query.startAfter(cursor);
                        const page = await query.get();
                        if (page.empty) break;
                        for (const doc of page.docs) { await processDocument(phase, doc, uid); await progress({}); }
                        cursor = phase.startsWith('orphan') ? page.docs.at(-1).ref.path : page.docs.at(-1).id;
                        await progress({cursor});
                    }
                }
                if (phase !== 'finish') await progress({phaseIndex: index + 1, cursor: null});
            }
            return true;
        } catch (error) {
            await db().runTransaction(async tx => {
                const job = (await tx.get(ref)).data();
                if (job?.owner === owner && job.status !== 'complete') tx.update(ref,
                    {status: 'retry', leaseUntil: 0, lastError: String(error.code || 'cleanup_failed').slice(0, 80)});
            });
            logger.error('Account deletion pending retry', {job: id, code: error.code || 'cleanup_failed'});
            return false;
        }
    }
    async function drain() {
        if (running || !getAdmin()) return;
        running = true;
        try {
            const jobs = await db().collection('account_deletions').where('status', 'in', ['queued', 'running', 'retry']).limit(10).get();
            for (const job of jobs.docs) await run(job.id);
            // Minimal receipts/tombstones expire after 30 days, even without configured TTL.
            for (const collection of ['account_deletions', 'account_deletion_blocks']) {
                const expired = await db().collection(collection).where('expiresAt', '<=', getAdmin().firestore.Timestamp.fromMillis(now())).limit(PAGE).get();
                for (const doc of expired.docs) await doc.ref.delete();
            }
        } finally { running = false; }
    }
    function kick() { drain().catch(error => logger.error('Deletion worker unavailable', error.code || 'unavailable')); }
    return {options, request, status, run, drain, kick};
}

function mountAccountDeletion(app, {service, authenticate, limit}) {
    const route = (path, auth, handler) => app.post(path, ...(auth ? [authenticate] : []), limit, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await handler(req, res); }
        catch (error) { res.status(error.status || 503).json({message: error.status ? error.message : 'Exclusao indisponivel. Tente novamente.'}); }
    });
    route('/account/deletion/options', true, async (req, res) => res.json({ministries: await service.options(req.firebaseUser.uid)}));
    route('/account/deletion/request', true, async (req, res) => {
        const result = await service.request(req.firebaseUser, req.body);
        res.status(202).json(result);
        service.kick();
    });
    route('/account/deletion/status', false, async (req, res) => res.json(await service.status(req.body?.receipt)));
    app.get('/account-deletion', (_req, res) => res.set({
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://identitytoolkit.googleapis.com; frame-ancestors 'none'; base-uri 'none'",
    }).sendFile(path.join(__dirname, '../public/account-deletion.html')));
    app.get('/account-deletion/config', (_req, res) => res.set('Cache-Control', 'no-store')
        .json({apiKey: process.env.FIREBASE_WEB_API_KEY || null}));
    app.get('/account-deletion.js', (_req, res) => res.sendFile(path.join(__dirname, '../public/account-deletion.js')));
    app.get('/account-deletion.css', (_req, res) => res.sendFile(path.join(__dirname, '../public/account-deletion.css')));
}
module.exports = {createAccountDeletionService, mountAccountDeletion, receiptId, cleanSchedule};
