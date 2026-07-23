const errors = [];
const requiredBoolean = ['WB_LIVE_DEPOSITS', 'WB_LIVE_RESUME', 'WB_LIVE_PAUSE'];

if (!/^[a-f0-9]{64}$/i.test(process.env.APP_ENCRYPTION_KEY || '')) {
  errors.push('APP_ENCRYPTION_KEY должен содержать ровно 64 hex-символа');
}
if (!String(process.env.ADMIN_USERNAME || '').trim()) errors.push('ADMIN_USERNAME не задан');
if (String(process.env.ADMIN_PASSWORD || '').length < 12) {
  errors.push('ADMIN_PASSWORD должен содержать не менее 12 символов');
}
for (const name of requiredBoolean) {
  if (!['true', 'false'].includes(String(process.env[name] || '').toLowerCase())) {
    errors.push(`${name} должен быть true или false`);
  }
}

const usernames = new Set([String(process.env.ADMIN_USERNAME || '').trim()]);
const raw = String(process.env.ADDITIONAL_USERS_JSON || '').trim();
if (raw) {
  try {
    const users = JSON.parse(raw);
    if (!Array.isArray(users)) throw new Error('значение не является массивом');
    for (const [index, user] of users.entries()) {
      const username = String(user?.username || '').trim();
      const password = String(user?.password || '');
      if (!username) errors.push(`У пользователя №${index + 1} отсутствует username`);
      if (password.length < 12) errors.push(`Пароль пользователя ${username || `№${index + 1}`} короче 12 символов`);
      if (usernames.has(username)) errors.push(`Логин повторяется: ${username}`);
      usernames.add(username);
      if ('legal_entity_ids' in (user || {})) {
        if (!Array.isArray(user.legal_entity_ids) ||
            user.legal_entity_ids.some(id => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
          errors.push(`legal_entity_ids пользователя ${username} должен быть массивом положительных ID`);
        }
      }
    }
  } catch (error) {
    errors.push(`ADDITIONAL_USERS_JSON содержит некорректный JSON: ${error.message}`);
  }
}

if (errors.length) {
  console.error('Конфигурация не прошла проверку:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Конфигурация корректна. Пользователей: ${usernames.size}.`);
