const { isDeepStrictEqual } = require('node:util');

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function validId(value) { return typeof value === 'string' && /^[\w-]{1,128}$/.test(value); }

function scheduleMutation(data, profile, uid, body, now) {
    const team = Array.isArray(data.team_assignments) ? data.team_assignments : [];
    if (!profile.church_id || profile.church_id !== data.church_id ||
        (!profile.is_admin && !team.some(item => item.uid === uid))) fail('Sem acesso a esta escala.', 403);
    if (body.action === 'respond') {
        if (!['accepted', 'declined'].includes(body.status)) fail('Resposta invalida.');
        let found = false;
        const updated = team.map(item => {
            if (item.uid !== uid || item.role !== body.role) return item;
            found = true;
            return { ...item, status: body.status, responded_at: now };
        });
        if (!found) fail('Participacao nao encontrada.', 404);
        return { team_assignments: updated };
    }
    const songs = Array.isArray(data.suggested_songs) ? data.suggested_songs : [];
    if (body.action === 'suggest') {
        const input = body.song;
        if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Cifra invalida.');
        const song = {};
        for (const field of ['title', 'artist', 'key', 'capo', 'originalKey', 'shapeKey', 'content', 'url', 'referenceUrl', 'bpm', 'rehearsalNotes']) {
            if (input[field] != null && typeof input[field] !== 'string') fail('Campo de cifra invalido.');
            if (typeof input[field] === 'string') song[field] = input[field].slice(0, field === 'content' ? 120000 : 1200);
        }
        if (!song.title || !song.artist || !song.content) fail('Cifra incompleta.');
        if (songs.some(s => s.title === song.title && s.artist === song.artist)) return {};
        if (songs.length >= 100) fail('Limite de sugestoes atingido.');
        return { suggested_songs: [...songs, { ...song, suggestedBy: profile.name || 'Membro', suggestedByUid: uid, upvotes: [uid], downvotes: [] }] };
    }
    if (body.action === 'vote') {
        if (!['up', 'down', 'none'].includes(body.vote)) fail('Voto invalido.');
        const index = songs.findIndex(s => s.title === body.title && s.artist === body.artist);
        if (index < 0) fail('Sugestao removida.', 404);
        const song = songs[index];
        const upvotes = (song.upvotes || []).filter(id => id !== uid);
        const downvotes = (song.downvotes || []).filter(id => id !== uid);
        if (body.vote === 'up') upvotes.push(uid);
        if (body.vote === 'down') downvotes.push(uid);
        return { suggested_songs: songs.map((s, i) => i === index ? { ...s, upvotes, downvotes } : s) };
    }
    fail('Acao desconhecida.');
}

function mountMemberActions(app, { authenticate, limit, getAdmin }) {
    const route = (path, handler) => app.post(path, authenticate, limit, async (req, res) => {
        try { res.json(await handler(getAdmin().firestore(), req.firebaseUser.uid, req.body)); }
        catch (error) {
            console.error('Member action:', path, error.code || error.status || 'internal');
            res.status(error.status || 503).json({ message: error.status ? error.message : 'Nao foi possivel concluir. Tente novamente.' });
        }
    });
    route('/members/profile', async (db, uid, body) => {
        const ref = db.collection('users').doc(uid);
        return db.runTransaction(async tx => {
            const snapshot = await tx.get(ref);
            if (!snapshot.exists) fail('Perfil nao encontrado.', 404);
            const profile = snapshot.data();
            let code = profile.friendCode;
            if (!code) {
                code = require('node:crypto').randomBytes(5).toString('hex').slice(0, 6).toUpperCase();
                const codeRef = db.collection('contact_codes').doc(code);
                const existing = await tx.get(codeRef);
                const duplicates = await tx.get(db.collection('users').where('friendCode', '==', code).limit(1));
                if (existing.exists || !duplicates.empty) fail('Tente gerar o codigo novamente.', 409);
                tx.create(codeRef, { uid });
                tx.update(ref, { friendCode: code });
            }
            tx.set(db.collection('public_profiles').doc(uid), { name: profile.name || 'Musico', roles: profile.roles || [], friendCode: code });
            return { friendCode: code };
        });
    });
    route('/members/join', async (db, uid, body) => {
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{6}$/.test(code)) fail('Codigo invalido.');
        await db.runTransaction(async tx => {
            const userRef = db.collection('users').doc(uid);
            const user = await tx.get(userRef);
            const invite = await tx.get(db.collection('ministry_invites').doc(code));
            if (!user.exists || !invite.exists || !validId(invite.data().ministry_id)) fail('Convite invalido.', 404);
            const ministry = await tx.get(db.collection('ministries').doc(invite.data().ministry_id));
            if (!ministry.exists || ministry.data().deletion_pending || ministry.data().invite_code !== code || ministry.data().admin_id !== invite.data().admin_id) fail('Convite expirado.', 403);
            if (user.data().is_admin === true) fail('Transfira a administracao antes de mudar de equipe.', 409);
            tx.update(userRef, { church_id: ministry.id, is_admin: false });
        });
        return { joined: true };
    });
    route('/members/schedule', async (db, uid, body) => {
        if (!validId(body.scheduleId)) fail('Escala invalida.');
        await db.runTransaction(async tx => {
            const ref = db.collection('schedules').doc(body.scheduleId);
            const profile = await tx.get(db.collection('users').doc(uid));
            const schedule = await tx.get(ref);
            if (!profile.exists || !schedule.exists) fail('Escala nao encontrada.', 404);
            const changes = scheduleMutation(schedule.data(), profile.data(), uid, body, getAdmin().firestore.Timestamp.now());
            if (Object.keys(changes).length && !isDeepStrictEqual(changes, {})) tx.update(ref, changes);
        });
        return { saved: true };
    });
    route('/members/contacts', async (db, uid) => {
        const owner = await db.collection('users').doc(uid).get();
        if (!owner.exists) fail('Perfil nao encontrado.', 404);
        const friends = owner.data().friends;
        const ids = [...new Set(Array.isArray(friends) ? friends.filter(validId) : [])];
        const contacts = [];
        for (let offset = 0; offset < ids.length; offset += 50) {
            const refs = ids.slice(offset, offset + 50).map(id => db.collection('users').doc(id));
            const snapshots = await db.getAll(...refs, { fieldMask: ['name'] });
            for (const snapshot of snapshots) {
                if (!snapshot.exists) continue;
                const name = snapshot.data().name;
                contacts.push({ id: snapshot.id, name: typeof name === 'string' && name.trim() ? name.trim() : 'Musico' });
            }
        }
        return { contacts };
    });
    route('/members/contact', async (db, uid, body) => {
        const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
        if (!/^[A-Z0-9]{6}$/.test(code)) fail('Codigo invalido.');
        const found = await db.collection('users').where('friendCode', '==', code).limit(2).get();
        if (found.size !== 1) fail('Codigo nao encontrado ou duplicado.', 404);
        const contact = found.docs[0];
        if (contact.id === uid) fail('Este e seu proprio codigo.');
        if (body.add === true) await db.collection('users').doc(uid).update({ friends: getAdmin().firestore.FieldValue.arrayUnion(contact.id) });
        return { id: contact.id, name: contact.data().name || 'Musico', roles: contact.data().roles || [] };
    });
}

module.exports = { mountMemberActions, scheduleMutation };
