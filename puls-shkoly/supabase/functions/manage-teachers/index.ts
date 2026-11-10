// Пульс школы · защищённое приглашение педагогов
// Запускается только на сервере Supabase Edge Functions.
// Никогда не переносите SUPABASE_SERVICE_ROLE_KEY в HTML или браузер.
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
const ADMIN_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
// Изменить SCHOOL_APP_URL в секретах Edge Function при переносе сайта.
const SITE_URL = Deno.env.get('SCHOOL_APP_URL') || 'https://savka86.github.io/my-site/puls-shkoly/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
function errorMessage(e: unknown): string { return e instanceof Error ? e.message : 'Ошибка сервера'; }
function validUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function validEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function validName(v: unknown): v is string { return typeof v === 'string' && v.trim().length >= 5 && v.trim().length <= 150; }
function adminHeaders(prefer?: string): HeadersInit {
  return {
    apikey: ADMIN_KEY,
    Authorization: `Bearer ${ADMIN_KEY}`,
    'Content-Type': 'application/json',
    ...(prefer ? { Prefer: prefer } : {}),
  };
}
async function adminRequest(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...opts, headers: { ...adminHeaders(), ...(opts.headers || {}) },
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof result.msg === 'string' ? result.msg :
    typeof result.message === 'string' ? result.message :
    typeof result.error_description === 'string' ? result.error_description :
    `Supabase ${res.status}`);
  return result;
}
async function getManager(userToken: string) {
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ADMIN_KEY, Authorization: `Bearer ${userToken}` },
  });
  if (!authRes.ok) return { status: 401, id: '' };
  const authUser = await authRes.json();
  if (!validUuid(authUser.id)) return { status: 401, id: '' };
  const managers = await adminRequest(`/rest/v1/school_profiles?select=id,role&id=eq.${encodeURIComponent(authUser.id)}&limit=1`);
  if (!Array.isArray(managers) || !['deputy', 'admin'].includes(managers[0]?.role)) return { status: 403, id: '' };
  return { status: 200, id: authUser.id as string };
}
async function classRecord(classId: string) {
  const rows = await adminRequest(`/rest/v1/school_classes?select=id,title,academic_year,period&id=eq.${encodeURIComponent(classId)}&limit=1`);
  if (!Array.isArray(rows) || !rows.length) throw new Error('Указанный класс не найден');
  return rows[0] as { id: string; title: string; academic_year: string; period: string };
}
async function saveTeacherProfile(userId: string, name: string, classId: string) {
  const result = await adminRequest('/rest/v1/school_profiles?on_conflict=id&select=id,full_name,role,class_id', {
    method: 'POST', headers: adminHeaders('resolution=merge-duplicates,return=representation'),
    body: JSON.stringify({ id: userId, full_name: name, role: 'teacher', class_id: classId }),
  });
  if (!Array.isArray(result) || !result.some(p => p.id === userId && p.role === 'teacher' && p.class_id === classId)) {
    throw new Error('Не удалось сохранить назначение учителя');
  }
}
async function updateClassTeacherNames(c: {title: string; academic_year: string}, name: string) {
  // Сохраняем имя классного руководителя для всех трёх периодов одного учебного года.
  await adminRequest(`/rest/v1/school_classes?title=eq.${encodeURIComponent(c.title)}&academic_year=eq.${encodeURIComponent(c.academic_year)}`, {
    method: 'PATCH', headers: adminHeaders('return=minimal'), body: JSON.stringify({ teacher_name: name }),
  });
}
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);
  if (!SUPABASE_URL || !ADMIN_KEY) return json({ error: 'Серверная авторизация ещё не настроена' }, 503);
  const rawToken = req.headers.get('Authorization') || '';
  if (!/^Bearer [^\s]+$/.test(rawToken)) return json({ error: 'Сначала войдите в кабинет завуча' }, 401);
  try {
    const manager = await getManager(rawToken.replace(/^Bearer /, ''));
    if (manager.status !== 200) return json({ error: manager.status === 403 ? 'Создавать педагогов может только завуч или администратор' : 'Войдите в систему заново' }, manager.status);
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== 'object') return json({ error: 'Неверные данные формы' }, 400);
    if (!validUuid(body.class_id)) return json({ error: 'Выберите класс из списка' }, 400);
    const c = await classRecord(body.class_id);
    if (body.action === 'invite') {
      if (!validEmail(body.email) || !validName(body.full_name)) return json({ error: 'Укажите корректные ФИО и email учителя' }, 400);
      const name = body.full_name.trim().replace(/\s+/g, ' ');
      const email = body.email.trim().toLowerCase();
      // Redirect URL задан только на сервере. Клиент не может подменить его на фишинговый.
      const invite = await adminRequest(`/auth/v1/invite?redirect_to=${encodeURIComponent(SITE_URL)}`, {
        method: 'POST', body: JSON.stringify({ email, data: { full_name: name } }),
      });
      if (!validUuid(invite.id)) return json({ error: 'Supabase не подтвердил создание приглашения' }, 502);
      try {
        await saveTeacherProfile(invite.id, name, c.id);
        await updateClassTeacherNames(c, name);
      } catch (err) {
        return json({ error: 'Приглашение создано, но класс не удалось назначить. Проверьте список педагогов и назначьте вручную.', detail: errorMessage(err), invited: true }, 500);
      }
      return json({ ok: true, message: 'Приглашение создано и отправлено через Supabase Auth', class_title: c.title });
    }
    if (body.action === 'assign') {
      if (!validUuid(body.user_id)) return json({ error: 'Неверный идентификатор педагога' }, 400);
      const rows = await adminRequest(`/rest/v1/school_profiles?select=id,full_name,role&id=eq.${encodeURIComponent(body.user_id)}&limit=1`);
      if (!Array.isArray(rows) || rows[0]?.role !== 'teacher') return json({ error: 'Можно назначить только классного руководителя' }, 403);
      const fullName = rows[0].full_name;
      await saveTeacherProfile(body.user_id, fullName, c.id);
      await updateClassTeacherNames(c, fullName);
      return json({ ok: true, message: 'Класс педагогу назначен', class_title: c.title });
    }
    return json({ error: 'Неизвестное действие' }, 400);
  } catch (err) {
    // Не возвращаем секреты или технические подробности внешним клиентам.
    const m = errorMessage(err);
    if (/already|registered|exists|duplicate|already been/i.test(m)) return json({ error: 'Пользователь с этой почтой уже существует. Назначьте ему класс в списке педагогов.' }, 409);
    if (/rate limit|email rate/i.test(m)) return json({ error: 'Превышен лимит отправки приглашений. Повторите позже или настройте SMTP.' }, 429);
    return json({ error: m.slice(0, 280) }, 400);
  }
});
