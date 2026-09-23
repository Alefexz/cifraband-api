const inFlight = new Map();
const activeRequestsFor = uid => inFlight.get(uid) || 0;
function createAuthenticator(getAdmin) {
    return async (req, res, next) => {
        const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
        if (!match) return res.status(401).json({error: 'missing_auth_token'});
        const admin = getAdmin();
        if (!admin) return res.status(503).json({error: 'firebase_admin_unavailable'});
        try {
            req.firebaseUser = await admin.auth().verifyIdToken(match[1], true);
        } catch (_) {
            return res.status(401).json({error: 'invalid_auth_token'});
        }
        const uid = req.firebaseUser.uid;
        inFlight.set(uid, activeRequestsFor(uid) + 1);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            const remaining = activeRequestsFor(uid) - 1;
            if (remaining > 0) inFlight.set(uid, remaining); else inFlight.delete(uid);
        };
        res.once('finish', release);
        const end = res.end;
        res.end = function (...args) {
            try { return end.apply(this, args); } finally { release(); }
        };
        // A disconnected client does not cancel its handler's pending writes.
        // Release on handler completion, not on the socket's close event.
        try {
            if ((await admin.firestore().collection('account_deletion_blocks').doc(req.firebaseUser.uid).get()).exists) {
                return res.status(403).json({error: 'account_deleting'});
            }
            return next();
        } catch (_) {
            return res.status(503).json({error: 'account_status_unavailable'});
        }
    };
}
module.exports = {createAuthenticator, activeRequestsFor};
