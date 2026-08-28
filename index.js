// functions/index.js

const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Inicializa o Admin SDK para termos acesso ao Banco de Dados e às Notificações
admin.initializeApp();

// Exporta a função que vai vigiar a coleção "schedules" (Escalas/Cultos)
exports.notificarEscala = functions.firestore
    .document("schedules/{scheduleId}")
    .onUpdate(async (change, context) => {
        
        // Pega os dados antes e depois da edição no banco
        const beforeData = change.before.data();
        const afterData = change.after.data();

        const scheduleTitle = afterData.title || "Culto";

        const beforeTeam = beforeData.team_assignments || [];
        const afterTeam = afterData.team_assignments || [];

        const beforeSongs = beforeData.suggested_songs || [];
        const afterSongs = afterData.suggested_songs || [];

        const promises = [];

        // ==============================================================
        // 1. CHECAR SE ALGUÉM NOVO FOI ESCALADO
        // ==============================================================
        if (afterTeam.length > beforeTeam.length) {
            // Descobre quem é a pessoa nova que acabou de ser adicionada
            const newMembers = afterTeam.filter(
                (newMem) => !beforeTeam.find((oldMem) => oldMem.uid === newMem.uid)
            );

            for (const member of newMembers) {
                const p = admin.firestore().collection("users").doc(member.uid).get().then((userDoc) => {
                    const fcmToken = userDoc.data()?.fcmToken;
                    
                    if (fcmToken) {
                        const message = {
                            notification: {
                                title: "🎸 Você foi escalado!",
                                body: `Sua presença foi solicitada para tocar ${member.role} no ${scheduleTitle}.`,
                            },
                            token: fcmToken,
                        };
                        console.log(`Enviando notificação de escala para: ${member.name}`);
                        return admin.messaging().send(message).catch(err => console.log("Erro no push:", err));
                    }
                });
                promises.push(p);
            }
        }

        // ==============================================================
        // 2. CHECAR SE UMA NOVA MÚSICA FOI SUGERIDA
        // ==============================================================
        if (afterSongs.length > beforeSongs.length) {
            // Descobre qual foi a música adicionada
            const newSongs = afterSongs.filter(
                (newSong) => !beforeSongs.find((oldSong) => oldSong.title === newSong.title)
            );

            for (const song of newSongs) {
                // Avisa TODO MUNDO que está escalado no culto que chegou música nova!
                for (const member of afterTeam) {
                    const p = admin.firestore().collection("users").doc(member.uid).get().then((userDoc) => {
                        const fcmToken = userDoc.data()?.fcmToken;
                        
                        if (fcmToken) {
                            const message = {
                                notification: {
                                    title: "🎵 Nova sugestão de repertório!",
                                    body: `${song.suggestedBy} sugeriu "${song.title}". Abra o app e deixe o seu voto!`,
                                },
                                token: fcmToken,
                            };
                            return admin.messaging().send(message).catch(err => console.log("Erro no push:", err));
                        }
                    });
                    promises.push(p);
                }
            }
        }

        // Aguarda todos os envios de notificação terminarem antes de desligar o robô
        await Promise.all(promises);
        return null;
    });