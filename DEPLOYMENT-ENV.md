# إعدادات بيئة الخادم والبناء

هذا الملف **قالب توثيقي فقط**. أنشئ القيم الفعلية في منصة الاستضافة أو في ملف `.env` محلي غير مرفوع. لا تضع مفتاح Qwen أو عنوان MongoDB أو مفتاح الخدمة في مصدر التطبيق أو في قيمة تبدأ بـ`EXPO_PUBLIC_`.

| المتغير | المكان | مطلوب | الغرض |
| --- | --- | --- | --- |
| `EXTERNAL_OPENAI_API_KEY` | الخادم فقط | نعم | مصادقة مزود Qwen لكشف صناديق النص. |
| `EXTERNAL_QWEN_BASE_URL` | الخادم فقط | لا | الافتراضي هو نهاية المزود المتوافق مع OpenAI المستخدمة في التطوير. |
| `MONGODB_URI` | الخادم فقط | لا | حفظ حالة المهمة وتقدمها ورسائل الخطأ فقط. |
| `MONGODB_DB_NAME` | الخادم فقط | لا | الافتراضي `manga_bubble_cleaner`. |
| `PORT` | الخادم فقط | لا | الافتراضي `3000`. |
| `ALLOWED_ORIGIN` | الخادم فقط | لواجهة ويب | أصل واجهة الويب المسموح به، مثل `https://studio.example.com`. |
| `SERVICE_API_KEY` | الخادم فقط | لا | حماية اختيارية للاتصالات الخادمية، مثل بوت Discord. |
| `EXPO_PUBLIC_API_BASE_URL` | بيئة بناء Expo فقط | نعم للإصدار المنشور | رابط HTTPS العام لخادم التبييض المملوك لك. |

## مثال لخادم محلي

```dotenv
EXTERNAL_OPENAI_API_KEY=ضع_مفتاح_المزود_هنا
MONGODB_URI=mongodb+srv://...
MONGODB_DB_NAME=manga_bubble_cleaner
PORT=3000
```

## مثال لبناء تطبيق

```dotenv
EXPO_PUBLIC_API_BASE_URL=https://cleaner.example.com
```

> `EXPO_PUBLIC_API_BASE_URL` عنوان عام وليس سرًا؛ أما كل المتغيرات الأخرى فتبقى في بيئة الخادم. إذا فُعّل `SERVICE_API_KEY`، يجب أن يرسله بوت Discord من خادمه الخاص. لا تضمّنه في IPA.
