# دليل نشر Manga Bubble Cleaner على Railway

> **الحالة الحالية:** يحتوي المستودع على `railway.json` يفرض استخدام Dockerfile وأمر التشغيل وفحص الصحة. ينتظر سكريبت الإقلاع جاهزية Big-LaMa وكاشف ONNX قبل تشغيل API؛ إذا فشل الكاشف يتوقف النشر بوضوح بدل تقديم صور غير معدلة مع HTTP 200. ما يزال الاعتماد البصري النهائي يتطلب عيناتك الفعلية قبل الاستخدام الإنتاجي.

## 1. ما الذي سيرفع إلى Railway؟

يرفع **الخادم فقط** مع كود تطبيق Expo في المستودع، لكن Railway لا يبني IPA ولا يخزّن الصور. يستقبل الخادم صفحة PNG أو JPG أو WebP في جسم طلب HTTP، يعالجها في الذاكرة، ويرد PNG في الاستجابة نفسها. لا يُنشئ ملفات الأصل أو النتيجة ولا يحتاج إلى Volume.

| المكان | البيانات المحفوظة | ما لا يُحفظ |
| --- | --- | --- |
| هاتف المستخدم | الأصل والنتيجة والمشاريع المحلية | مفتاح Qwen ومفتاح MongoDB |
| Railway RAM | بايتات الطلب والنتيجة طوال مدة الطلب فقط | أي صورة بعد انتهاء الرد أو إعادة تشغيل الخادم |
| MongoDB | معرف المهمة، الحالة، التقدم، الأبعاد والخطأ لمدة 7 أيام | الأصل، الناتج، base64، رابط تنزيل |

إذا أعيد تشغيل Railway أثناء المعالجة، لن يستطيع الخادم استئناف البكسلات؛ يعيد سجل المهمة الحالة `requires-reupload`. هذا سلوك مقصود، لا فقد تخزين عارض.

## 2. ما تحتاجه قبل البدء

جهّز حساب Railway، وحساب GitHub، ومستودعًا **خاصًا**، ومفتاح مزود Qwen الخارجي. إن أردت استمرار سجل الحالات بعد إعادة التشغيل، جهّز كذلك قاعدة MongoDB؛ لا تضع أي مفتاح في ملفات المشروع أو في تطبيق Expo.

لا ترفع `node_modules` أو `dist` أو ملف `.env` أو صور الاختبارات. يوجد `.gitignore` في المشروع لهذا الغرض. ارفع محتوى أرشيف المصدر إلى مستودع GitHub خاص، مع بقاء بنية الملفات كما هي بحيث يكون `package.json` في الجذر.

## 3. إنشاء خدمة Railway من GitHub

1. في لوحة Railway اختر **New Project** ثم **GitHub Repo**، واربط GitHub إن طلب منك ذلك، واختر مستودع Manga Bubble Cleaner الخاص.
2. اختر **Add Variables** بدل تشغيل أول نشر قبل ضبط الأسرار. تدعم Railway متغيرات لكل خدمة من تبويب **Variables**، ولا تطبق تغييرها حتى تراجعه وتنشره.[1]
3. ملف `railway.json` يضبط Dockerfile وStart Command وHealthcheck تلقائيًا. إذا كانت إعدادات لوحة Railway تتغلب عليه في مشروع قديم، اجعل الإعدادات كما يلي:

```text
Build: Dockerfile
Start Command: pnpm start
Healthcheck Path: /api/health
```

يقرأ التطبيق متغير `PORT` الذي تضيفه Railway تلقائيًا ويستمع له؛ تستخدم Railway هذا المنفذ نفسه عند تنفيذ health check.[2]

4. اضغط **Deploy**. عند ظهور نشر ناجح، افتح سجل البناء والتشغيل. يجب أن يظهر سطر شبيه بـ`[standalone-api] listening on ...`.
5. من **Settings → Networking → Public Networking** اختر **Generate Domain**. تحصل الخدمة على نطاق HTTPS من Railway مع شهادة SSL تلقائية.[3]

> لا تضف Volume لهذه الخدمة؛ طلبك هو عدم حفظ الصور على قرص الخادم، والخادم لا يحتاج قرصًا دائمًا. MongoDB الخارجي هو السجل الوصفي الاختياري فقط.

## 4. متغيرات البيئة في Railway

أضف المتغيرات التالية من تبويب **Variables** في خدمة الخادم. لا ترسل قيَم الأسرار في Discord أو لقطة شاشة أو مستودع GitHub.

| المتغير | مطلوب | قيمة/ملاحظة |
| --- | --- | --- |
| `EXTERNAL_OPENAI_API_KEY` | نعم | مفتاح مزود Qwen. يبقى على الخادم فقط. |
| `EXTERNAL_QWEN_BASE_URL` | مستحسن | `https://ggg-production-739f.up.railway.app/v1` ما لم تغيّر مزودك. |
| `MONGODB_URI` | نعم وفق تصميمك | رابط اتصال MongoDB. يستخدم للحالات فقط، لا للصور. |
| `MONGODB_DB_NAME` | لا | اتركه `manga_bubble_cleaner` أو اختر اسمًا خاصًا بك. |
| `NODE_ENV` | مستحسن | `production`. |
| `ALLOWED_ORIGIN` | فقط لواجهة ويب | الأصل الدقيق للواجهة، مثال `https://studio.example.com`، بلا مسار `/api`. لا تحتاجه لتطبيق iOS/Android الأصلي. |
| `SERVICE_API_KEY` | اختياري للبوت | مفتاح اتصال خادم-إلى-خادم لبوت Discord لاحقًا؛ لا تضعه في IPA. |

لا تضف `EXPO_PUBLIC_API_BASE_URL` هنا **كمتغير للخادم**؛ هذا متغير يُضمّن عند بناء تطبيق Expo فقط في الخطوة 7.

## 5. اختبار الخدمة بعد النشر

استبدل `https://YOUR-RAILWAY-DOMAIN` بالنطاق الذي ولّدته Railway. يجب أن يعيد هذا الطلب HTTP 200 و`imagesPersisted:false`:

```bash
curl -i https://YOUR-RAILWAY-DOMAIN/api/health
```

اختبر معالجة صفحة صغيرة أولًا. يبقى الملفان اللذان في الأمر أدناه على جهازك، ولا يقوم الأمر بتخزينهما داخل Railway:

```bash
curl --fail-with-body \
  -H 'Content-Type: image/png' \
  -H 'X-File-Name: test-page.png' \
  -H 'X-Cleaning-Quality: preserve-detail' \
  --data-binary @test-page.png \
  https://YOUR-RAILWAY-DOMAIN/api/v1/clean \
  -o test-page-clean.png
```

النجاح يعني أن `test-page-clean.png` ملف PNG صالح وبالأبعاد المتوقعة. تجنب إرسال فصل طويل كامل في أول اختبار؛ ابدأ بمقطع أو صفحة واحدة، ثم راجع النتيجة بصريًا قبل استخدام الطابور.

| الرمز | معناه | التصرف الصحيح |
| --- | --- | --- |
| `200` | تمت المعالجة وأُعيد PNG | راجع الصورة، ولا تكتفِ بنجاح HTTP. |
| `401` | أُرسل `SERVICE_API_KEY` خاطئًا أو ناقصًا | أرسله من البوت/الخادم الموثوق فقط ضمن `Authorization: Bearer …`. |
| `413` | حجم الملف يتجاوز 20MB أو الأبعاد فوق 20 مليون بكسل | صدّر الصفحة بضغط أفضل أو قسّمها قبل الرفع. |
| `422` | تعذّر قراءة الصورة أو فشل كشف Qwen | راجع Logs وتحقق من مفتاح Qwen ونوع الصورة. |
| `429` | الخادم يعالج صفحة أخرى | انتظر ثم أعد الإرسال؛ الحاجز يمنع استهلاك الذاكرة بمهام متوازية. |

يمكنك فحص الحالة الوصفية عبر `GET /api/v1/jobs/<job-id>` بعد التقاط رأس `X-Cleaner-Job-Id` من الاستجابة. لا تتوقع رابط تنزيل للنتيجة؛ لا يوجد واحد عمدًا.

## 6. التشخيص في Railway

تلتقط Railway مخرجات `console.log` و`console.error` في سجلات النشر، ويمكنك فتحها من لوحة النشر أو صفحة Observability.[4] ابدأ دائمًا بسجل البناء ثم سجل التشغيل.

| العرض | أين تبحث | الحل المعتاد |
| --- | --- | --- |
| فشل البناء | Build Logs | تأكد أن المستودع يحتوي `pnpm-lock.yaml` و`package.json` في الجذر وأن Build Command هو `pnpm build`. |
| Healthcheck لم يصل إلى 200 | Deploy Logs + Settings | اجعل المسار `/api/health` ولا تعيّن `PORT` ثابتًا يناقض منفذ Railway. |
| `502 Application failed to respond` | Deploy Logs | تحقق من ظهور `listening on …` ومن Start Command `pnpm start`. |
| فشل MongoDB | Deploy Logs | راجع `MONGODB_URI` والسماح من شبكتك/مزود القاعدة. تظل المعالجة ممكنة لكن حالة المهمة لن تبقى بعد إعادة التشغيل. |
| `422` من Qwen | Deploy Logs | تحقق من `EXTERNAL_OPENAI_API_KEY` وحدود المزود؛ لا تسجل أو تنسخ قيمة المفتاح. |
| أخطاء CORS في واجهة ويب | Console المتصفح + Variables | اضبط `ALLOWED_ORIGIN` على أصل الواجهة بالضبط. |

Health check في Railway يتحقق من أن الإصدار الجديد يعيد 200 قبل تحويل الطلبات إليه، لكنه ليس مراقبة مستمرة بعد النشر؛ استخدم مراقبة خارجية إذا احتجت تنبيه أعطال دائم.[2]

## 7. توصيل تطبيق Expo بعد نجاح اختبار Railway

بعد نجاح اختبار `curl`، خذ نطاق Railway، مثل `https://manga-cleaner-production.up.railway.app`، واضبط **وقت بناء التطبيق**:

```text
EXPO_PUBLIC_API_BASE_URL=https://manga-cleaner-production.up.railway.app
```

أعد بناء IPA/AAB بعد ضبطه؛ هذا العنوان مضمّن في الحزمة المنشورة. لا تضف مفتاح Qwen أو `MONGODB_URI` أو `SERVICE_API_KEY` إلى متغيرات `EXPO_PUBLIC_*`، لأنها تصبح قابلة للاستخراج من التطبيق.

لا توزع النسخة على الفريق قبل إضافة مصادقة مستخدمين وحدود استخدام. التطبيق الأصلي لا يمكنه حفظ مفتاح ثابت بأمان؛ `SERVICE_API_KEY` مصمم لخادم Discord موثوق، لا لنسخة IPA عامة.

## 8. تشغيل بوت Discord في الخدمة نفسها

يتضمن المشروع الآن بوتًا رسميًا بالأمر `/clean` يعمل داخل عملية الخادم نفسها. لا تضف خدمة Railway ثانية: أضف `DISCORD_BOT_TOKEN` و`DISCORD_GUILD_ID` و`DISCORD_ENABLED=true` إلى متغيرات **الخدمة الحالية** بعد دعوة البوت إلى خادم Discord خاص للفريق. تفاصيل إنشاء التطبيق، الدعوة، الأذونات، والقيود الأمنية موجودة في [دليل بوت Discord](./DISCORD-BOT-SETUP.md).

## 9. خطة اختبار آمنة قبل الاستخدام الفعلي

ابدأ ببيئة Railway اختبارية ونطاقها، ثم نفّذ اختبارًا يدويًا على عينات تمثل عملك: فقاعة بيضاء، فقاعة متدرجة/ملونة، نص بحد وظل، وفقاعة بجانب رسم معقد. راجع كل ناتج قبل الترجمة أو الإرسال.

> الخادم اجتاز اختبارات TypeScript وVitest، ونقطة الصحة وأمر إنتاجه. **لكنه لم يجتز اعتماد الجودة البصرية النهائي**: ظهرت بقايا نص في اختبار حديث لفقاعة فعلية. نجاح النشر لا يساوي نجاح التبييض، ولا أوصي بإطلاقه لفريق الترجمة حتى إصلاح ذلك الخلل وإعادة اختباره.

## المراجع

[1]: https://docs.railway.com/variables "Railway — Using Variables"
[2]: https://docs.railway.com/deployments/healthchecks "Railway — Healthchecks"
[3]: https://docs.railway.com/networking/public-networking "Railway — Public Networking"
[4]: https://docs.railway.com/guides/logs "Railway — Logs"
