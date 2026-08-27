# ملاحظات تكامل Google Drive

يعتمد تدفق Drive المقترح على حساب خدمة يملك صلاحية إنشاء مجلد نتائج ورفع الملفات إليه. عند إنشاء الملفات يجب تمرير اسم يتضمن امتدادًا، وإنشاء المجلد يتم كملف وصفي بنوع `application/vnd.google-apps.folder`. للملفات الأكبر أو القابلة لانقطاع الشبكة، توصي وثائق Google بالرفع القابل للاستئناف؛ وهو مناسب لنتائج الفصول وملفات ZIP.[1] [2]

لا يكفي رابط المجلد وحده للوصول. بعد إنشاء مجلد النتائج، تنشأ أذونة `type=anyone` و`role=reader` مع `allowFileDiscovery=false` حتى يصبح الرابط قابلاً للفتح لمن يعرفه دون جعله ظاهرًا في البحث. يرث ما بداخله أذونته من المجلد؛ لذلك لا تُنشأ أذونات عامة منفصلة لكل صورة.[3]

| قرار التصميم | التنفيذ |
| --- | --- |
| مصدر Drive | يجب أن يشارك المستخدم الملف/المجلد مع بريد حساب الخدمة كقارئ، أو يتيح الوصول بالرابط. |
| نتائج Drive | ينشئ البوت مجلدًا جديدًا باسم المصدر مع لاحقة `-cleaned`، ويرفع النتائج داخله بأسماء الأساس الأصلية وامتداد PNG. |
| الخصوصية على الخادم | بايتات كل صورة والـZIP تعيش في الذاكرة فقط حتى الرفع؛ لا تستخدم ملفات مؤقتة أو Volume. |
| مشاركة النتيجة | رابط ثابت للمجلد بصلاحية قارئ لمن يملك الرابط فقط، ثم يعيده البوت في رسالة Discord خاصة. |

## المراجع

[1]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create "Google Drive API — files.create"
[2]: https://developers.google.com/workspace/drive/api/guides/manage-uploads "Google Drive API — Upload file data"
[3]: https://developers.google.com/workspace/drive/api/guides/manage-sharing "Google Drive API — Share files, folders, and drives"
