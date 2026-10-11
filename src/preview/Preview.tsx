import { useMemo, useState } from 'react';
import { Moon, Sun, Wifi, WifiOff } from 'lucide-react';
import ChatView from '../components/ChatView';
import type { PhotoState } from '../hooks/useMedia';
import { useApplyTheme } from '../lib/theme';
import { useLocalSettings } from '../lib/settings';
import type { ChatMessage } from '../types';
import { makeArt } from './photos';

// Превью чата без входа: те же компоненты и стили (ChatView),
// данные фейковые. Открыть: http://localhost:5173/test
// Панель сверху слева: тема / печатает / офлайн — для проверки состояний.

const ME = 'me-uid';
const PEER = 'peer-uid';

// URL выбранных в превью фото (вне React — переживает ререндеры).
const previewPhotoUrls = new Map<string, string>();

const TEXTS = [
  'Привет! Как дела?',
  'Нормально, допиваю кофе. Ты где?',
  'Уже выхожу, буду через десять минут',
  'Не забудь ключи от дачи',
  'Они у меня в рюкзаке с прошлого раза',
  'Кстати, видел вчера закат? Небо горело',
  'Ага, успел сфоткать. Сейчас скину',
  'Жду. Заварила чай',
  'Как прошёл день?',
  'Долго. Расскажу вечером',
  'Ты уже дома?',
  'Почти, зашёл за хлебом',
  'Тебе что-нибудь взять?',
  'Что-нибудь сладкое',
  'И мандарины, они пахнут зимой',
  'Сделаю. Буду через десять минут',
  'Тогда бегу',
  'Созвон в восемь не забудь',
  'Помню. Подготовлю цифры к вечеру',
  'Отправил файл на почту, глянь',
  'Посмотрю после ужина',
  'Там ещё смета за прошлый месяц',
  'Угу, видел. Всё сходится',
  'Отлично. Тогда до завтра',
  'До завтра! Спокойной ночи',
  'Доброе утро! Выспалась?',
  'Более-менее. Кофе уже варится',
  'Я у подъезда, выходи',
  'Минуту, надеваю куртку',
  'Не торопись, я припарковался удобно',
  'Взяла зонт? Тучи ходят',
  'Взяла. И термос',
  'Ты лучшая',
  'Знаю. Поехали?',
  'Поехали. Навигатор говорит 25 минут',
  'Заедем за цветами маме?',
  'Давай, там по пути рынок',
  'Какие берём — хризантемы?',
  'Она любит белые. И ленту синюю',
  'Понял, записал',
  'Кстати, кот опять спит на клавиатуре',
  'Классика. Сфоткай!',
  'Уже. Смотри какое чудо',
  'Ого, пушистый комок',
  'Ладно, я побежал на встречу',
  'Удачи! Напиши как закончишь',
  'Договорились. Целую',
  'И я тебя. До вечера',
];

const ART_COUNT = 6;

interface PoolMsg extends ChatMessage {
  artSeed?: number;
}

function buildPool(): { messages: PoolMsg[]; photos: Record<string, PhotoState> } {
  const messages: PoolMsg[] = [];
  const photos: Record<string, PhotoState> = {};
  let ts = Date.now() - 3 * 24 * 3600 * 1000; // три дня назад
  let photoEvery = 0;
  for (let i = 0; i < 170; i += 1) {
    const mine = i % 2 === 0;
    ts += (2 + ((i * 37) % 180)) * 60 * 1000; // 2–182 мин между сообщениями
    if (ts > Date.now()) ts = Date.now() - (170 - i) * 60 * 1000;
    const id = `pv-${i}`;
    photoEvery += 1;
    if (photoEvery >= 7 && i > 4) {
      photoEvery = 0;
      const seed = i % ART_COUNT;
      const url = makeArt(seed);
      photos[id] = { status: 'ready', url };
      messages.push({
        id,
        clientMessageId: id,
        senderId: mine ? ME : PEER,
        createdAtMs: ts,
        kind: 'photo',
        mediaId: `m-${id}`,
        driveFileId: `d-${id}`,
        mimeType: 'image/jpeg',
        size: 42000,
        iv: 'iv',
        text: '[фото]',
        status: mine ? (i < 150 ? 'read' : 'sent') : 'sent',
        artSeed: seed,
      });
      continue;
    }
    messages.push({
      id,
      clientMessageId: id,
      senderId: mine ? ME : PEER,
      createdAtMs: ts,
      kind: 'text',
      text: TEXTS[i % TEXTS.length],
      status: mine ? (i < 150 ? 'read' : 'sent') : 'sent',
    });
  }
  return { messages, photos };
}

const PAGE = 60;

export default function Preview() {
  const { settings, update: updateSettings } = useLocalSettings();
  const theme = useApplyTheme(settings.theme);
  const pool = useMemo(() => buildPool(), []);
  const [count, setCount] = useState(80); // сколько newest видно
  const [extra, setExtra] = useState<PoolMsg[]>([]);
  const [typing, setTyping] = useState(false);
  const [forceOffline, setForceOffline] = useState(false);
  const [pushOn, setPushOn] = useState(true);
  const [photoTick, setPhotoTick] = useState(0);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const visible = useMemo(
    () => [...pool.messages.slice(-count), ...extra].sort((a, b) => a.createdAtMs - b.createdAtMs),
    [pool, count, extra],
  );
  const photos = useMemo(() => {
    const out = { ...pool.photos };
    for (const m of extra) {
      if (m.kind === 'photo' && m.artSeed != null && !out[m.id]) {
        out[m.id] = { status: 'ready', url: makeArt(m.artSeed) };
      }
    }
    return out;
  }, [pool, extra]);

  const loadOlder = async (): Promise<number> => {
    const total = pool.messages.length + extra.length;
    if (count >= total && extra.length === 0) return 0;
    // Добираем из пула (эмуляция IDB/сервера): oldest видимых минус страница.
    const all = [...pool.messages, ...extra].sort((a, b) => a.createdAtMs - b.createdAtMs);
    const shown = new Set(visible.map((m) => m.id));
    const older = all.filter((m) => !shown.has(m.id)).slice(-PAGE);
    if (older.length === 0) return 0;
    setCount((c) => c + older.length);
    return older.length;
  };

  const submitText = async (body: string): Promise<void> => {
    const id = `pv-local-${Date.now()}`;
    setExtra((prev) => [
      ...prev,
      {
        id,
        clientMessageId: id,
        senderId: ME,
        createdAtMs: Date.now(),
        kind: 'text',
        text: body,
        status: 'sent',
      },
    ]);
  };

  const pickFile = (f: File) => {
    const url = URL.createObjectURL(f);
    const id = `pv-local-${Date.now()}`;
    setExtra((prev) => [
      ...prev,
      {
        id,
        clientMessageId: id,
        senderId: ME,
        createdAtMs: Date.now(),
        kind: 'photo',
        mediaId: `m-${id}`,
        driveFileId: `d-${id}`,
        mimeType: f.type || 'image/jpeg',
        size: f.size,
        iv: 'iv',
        text: '[фото]',
        status: 'sent',
      },
    ]);
    // Регистрируем url в photos (map вне React + тик для пересчёта).
    previewPhotoUrls.set(id, url);
    setPhotoTick((x) => x + 1);
  };
  const photosWithLocal = useMemo(() => {
    const out = { ...photos };
    for (const [id, url] of previewPhotoUrls) {
      if (!out[id]) out[id] = { status: 'ready', url };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos, photoTick]);
  const viewerEntry = viewerId ? photosWithLocal[viewerId] : undefined;
  const viewer = viewerEntry?.status === 'ready' ? { url: viewerEntry.url } : null;

  return (
    <>
      <div
        style={{
          position: 'fixed',
          bottom: 96,
          left: 8,
          zIndex: 40,
          display: 'flex',
          gap: 6,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          padding: 4,
        }}
      >
        <button
          className="icon-btn"
          title="Тема"
          onClick={() =>
            updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' })
          }
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button
          className={`icon-btn${typing ? ' active' : ''}`}
          title="Печатает"
          onClick={() => setTyping((v) => !v)}
        >
          <span style={{ fontSize: 15, fontWeight: 700 }}>…</span>
        </button>
        <button
          className={`icon-btn${forceOffline ? ' active' : ''}`}
          title="Офлайн"
          onClick={() => setForceOffline((v) => !v)}
        >
          {forceOffline ? <WifiOff size={17} /> : <Wifi size={17} />}
        </button>
      </div>
      <ChatView
        meUid={ME}
        userEmail="preview@example.com"
        messages={visible}
        photos={photosWithLocal}
        peerName={settings.peerName}
        peerOnline={!forceOffline}
        peerTyping={typing && !forceOffline}
        peerStatusText={
          forceOffline ? 'переподключение…' : typing ? 'печатает…' : 'в сети'
        }
        offline={forceOffline}
        error={null}
        sending={false}
        photoBusy={false}
        viewer={viewer}
        settings={settings}
        updateSettings={updateSettings}
        resetAppearance={() =>
          updateSettings({
            theme: 'system',
            bubbleGlassMine: false,
            bubbleGlassTheirs: false,
            bubbleColorMine: null,
            bubbleColorTheirs: null,
          })
        }
        avatarUrl={null}
        wallpaperUrl={null}
        onPickAvatar={() => {}}
        onClearAvatar={() => {}}
        onPickWallpaper={() => {}}
        onClearWallpaper={() => {}}
        onSubmitText={submitText}
        onPickFile={pickFile}
        onRetryPhoto={() => {}}
        onOpenViewer={(id) => setViewerId(id)}
        onCloseViewer={() => setViewerId(null)}
        onRestoreDraft={() => null}
        setTypingActive={() => {}}
        ensurePhotos={() => {}}
        markSeen={() => {}}
        onLoadOlder={loadOlder}
        pushOn={pushOn}
        pushBusy={false}
        onTogglePush={() => setPushOn((v) => !v)}
        pushStatus={pushOn ? 'push ok (preview)' : null}
        onShowKey={() => {}}
        onLogout={() => {}}
        onWipeDevice={() => {}}
        debugLines={['preview: /test · 170 сообщений в пуле', 'настройки — общие с боевым (localStorage)']}
      />
    </>
  );
}
