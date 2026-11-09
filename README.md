# واجهة توليد فيديو متعددة المزودين

واجهة ويب محلية مع backend صغير (Node.js) لتوليد فيديوهات AI. تبدّل بين المزودين بتغيير المفتاح في `.env` فقط.

## التشغيل المحلي

يحتاج: Node.js 20.12 أو أحدث، و ffmpeg (للمزود التجريبي والدمج).

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

افتح http://127.0.0.1:3000

بدون أي مفتاح، يشتغل مزود **Mock**: يولّد فيديو اختباري محلياً بـ ffmpeg، مجاناً، لتجربة الواجهة والقائمة والحدود والتحميل.

## البنية

```
server/
  index.js            API + يخدم الواجهة
  config.js           قراءة .env (على السيرفر فقط)
  queue.js            قائمة انتظار متتابعة: رفع صور → إنشاء مهمة → فحص → تحميل
  store.js            عداد الاستخدام والحدود (data/usage.json) وسجل المهام
  stitch.js           دمج مقاطع بـ ffmpeg
  providers/
    http.js           طلبات HTTP وتصنيف الأخطاء (رصيد / مفتاح / حد طلبات …)
    wavespeed.js      WaveSpeedAI
    atlas.js          Atlas Cloud
    mock.js           مزود تجريبي محلي
    _template.js      قالب لمزود جديد
    index.js          سجل المزودين
public/               الواجهة (عربي، RTL)
tools/upscale.sh      رفع الدقة محلياً بـ Real-ESRGAN
output/               الفيديوهات المحمّلة
```

كل adapter فيه: `baseUrl`، `envKey`، اسم الموديل، `uploadImage`، `createTask`، `getStatus`، `getResult`، و `getBalance` (اختياري).

**إضافة مزود:** انسخ `server/providers/_template.js`، عبّيه، وأضفه للقائمة في `server/providers/index.js`.

## الحماية من صرف الرصيد

- `MAX_GENERATIONS_TOTAL` (افتراضي 20): حد أقصى للتوليد. يُحسب عند قبول المزود للمهمة، لأنه وقت الخصم.
- `<PROVIDER>_MAX_GENERATIONS`: حد لكل مزود (مثل `WAVESPEED_MAX_GENERATIONS=2`).
- القائمة **تتوقف** تلقائياً عند خطأ رصيد (HTTP 402 أو رسالة فيها balance/credit/quota) أو مفتاح مرفوض أو وصول الحد. المهام الباقية تبقى بالانتظار حتى تضغط "استئناف".
- ما في إعادة محاولة تلقائية لإنشاء المهمة، لأنها ممكن تنشئ مهمة مدفوعة تانية.
- الفيديو يتحمّل على السيرفر (`output/`) فور نجاحه، وكمان بالمتصفح. روابط المزودين بتنتهي (Seedance عادة خلال 24 ساعة).
- عداد بالواجهة: المستخدم / المتبقي، والرصيد الحقيقي لو المزود بيوفر endpoint (WaveSpeed: `/api/v3/balance`، غير مؤكد أنه متاح لكل الحسابات).

لتجربة توقف القائمة: `MOCK_CREDIT_FAIL_AFTER=2` في `.env`، وأضف 4 فيديوهات للـ Mock.

## المزودين: ما تم التحقق منه من الوثائق الرسمية (9/11/2026)

| | WaveSpeedAI | Atlas Cloud |
|---|---|---|
| إنشاء مهمة | `POST https://api.wavespeed.ai/api/v3/{model}` | `POST https://api.atlascloud.ai/api/v1/model/generateVideo` |
| فحص الحالة | `GET /api/v3/predictions/{id}/result` | `GET /api/v1/model/prediction/{id}` |
| الموديل الافتراضي | `bytedance/seedance-2.0/reference-to-video` (مع صور) و `text-to-video` | `bytedance/seedance-2.0/text-to-video` |
| المدة | 4–15 ث | 4–15 ث |
| الصور | `reference_images` (روابط، الحد غير مذكور) | **غير مؤكد**: اسم الحقل ومعرّف موديل الصور، تأكد من الـ playground |
| خطأ الرصيد | غير موثق، يُكشف من الرسالة | HTTP 402 (موثق) |
| السعر الرسمي (Seedance 2.0) | 480p ‏$0.60/5ث، 720p ×2، 1080p ×5 (15ث 1080p = $9) | حسب صفحة الموديل |
| الرصيد المجاني | بدون رقم. حسب مقالهم 1080p مدفوع | بدون رقم بالوثائق |

**قبل ما تحط مفتاح أي مزود:** افتح صفحته الرسمية وتأكد من: هل بيطلب بطاقة؟ كم الرصيد المجاني؟ أقصى دقة ومدة بالمجان؟ علامة مائية؟ إذا طلب بطاقة: استبعده.

## خطوة الاختبار الأولى

1. حط المفتاح في `.env`، و `WAVESPEED_MAX_GENERATIONS=1` كحماية.
2. من الواجهة: 480p، ‏4 ثواني، فيديو واحد.
3. لاحظ الرصيد قبل وبعد عشان تعرف التكلفة الحقيقية بالمجان.

## إذا المجاني ما بيعطي 1080p و15 ثانية

- **دمج مقاطع:** ولّد عدة مقاطع، اختارها من القائمة، واضغط "دمج المحدد". نفس المزود ونفس الإعدادات = دمج بدون إعادة ترميز.
- **رفع الدقة محلياً:** `tools/upscale.sh in.mp4 out.mp4 2` (يحتاج [Real-ESRGAN ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN/releases)، ويفضّل GPU). مثلاً 720p ← 1440p ثم تصغير لـ1080p. الجودة أقل من 1080p الأصلي.
- **توزيع على منصات:** حط مفاتيح عدة مزودين، وحدد حد لكل واحد حسب رصيده.

## API

| | |
|---|---|
| `GET /api/providers` | المزودين وقدراتهم |
| `GET /api/usage?balance=1` | العداد والرصيد |
| `POST /api/jobs` | multipart: `prompt, provider, duration, resolution, aspectRatio, count, images[]` |
| `GET /api/jobs` | المهام وحالة القائمة |
| `DELETE /api/jobs/:id` | إلغاء مهمة منتظرة |
| `POST /api/jobs/:id/retry` | إعادة مهمة فاشلة |
| `POST /api/queue/resume` | استئناف |
| `POST /api/queue/clear` | إلغاء كل المنتظر |
| `POST /api/stitch` | `{ jobIds: [...] }` |
