'use strict';
const byId = id => document.getElementById(id);
let token = null;
let receipt = null;
let ministries = [];
async function jsonPost(url, body, authenticated = false) {
    const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json',
        ...(authenticated ? {Authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000), cache: 'no-store', credentials: 'omit'});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Nao foi possivel confirmar. Verifique os dados e tente novamente.');
    return data;
}
byId('login').addEventListener('submit', async event => {
    event.preventDefault();
    byId('loginButton').disabled = true;
    byId('message').textContent = 'Verificando identidade...';
    try {
        const config = await (await fetch('/account-deletion/config', {cache: 'no-store'})).json();
        if (!config.apiKey) throw new Error('Solicitacao web ainda nao configurada. Use Perfil → Excluir conta e dados no aplicativo.');
        const auth = await jsonPost(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`,
            {email: byId('email').value, password: byId('password').value, returnSecureToken: true});
        token = auth.idToken;
        const options = await jsonPost('/account/deletion/options', {}, true);
        ministries = options.ministries;
        byId('successors').replaceChildren();
        for (const ministry of ministries.filter(m => m.members.length)) {
            const label = document.createElement('label');
            label.textContent = `Novo administrador: ${ministry.name}`;
            const select = document.createElement('select');
            select.id = `successor-${ministry.id}`;
            select.required = true;
            select.add(new Option('Selecione um integrante', ''));
            for (const member of ministry.members) select.add(new Option(member.name, member.uid));
            label.append(select); byId('successors').append(label);
        }
        byId('confirm').hidden = false;
        byId('login').hidden = true;
        byId('message').textContent = 'Identidade confirmada. Confira a exclusao abaixo.';
    } catch (error) { byId('message').textContent = error.message; token = null; }
    finally { byId('password').value = ''; byId('loginButton').disabled = false; }
});
byId('confirm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('button'); button.disabled = true;
    receipt ||= Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    byId('receipt').value = receipt;
    byId('message').textContent = 'Enviando solicitacao. Guarde o protocolo abaixo mesmo se a conexao cair.';
    const successors = Object.fromEntries(ministries.filter(m => m.members.length).map(m => [m.id, byId(`successor-${m.id}`).value]));
    try {
        await jsonPost('/account/deletion/request', {confirm: true, receipt, successors}, true);
        token = null; byId('confirm').hidden = true;
        byId('message').textContent = 'Solicitacao aceita. Guarde seu protocolo e consulte o andamento abaixo.';
    } catch (error) { byId('message').textContent = `${error.message} Consulte o protocolo antes de tentar de novo.`; }
    finally { button.disabled = false; }
});
byId('status').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('button'); button.disabled = true;
    try {
        const data = await jsonPost('/account/deletion/status', {receipt: byId('receipt').value.trim()});
        byId('result').textContent = data.status === 'complete' ? 'Conta excluida. Limpeza no servidor concluida.'
            : 'Solicitacao aceita. Limpeza pendente ou em processamento; interrupcoes sao retomadas automaticamente.';
    } catch (error) { byId('result').textContent = error.message; }
    finally { button.disabled = false; }
});
