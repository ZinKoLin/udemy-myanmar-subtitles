> Version 0.7.0: browser model ရွေးချယ်မှုကို job နှင့်အတူ လက်ခံပါသည်။ မူလမှာ Hydrogen Medium ဖြစ်ပါသည်။ Server package ကို update လုပ်ပြီး container ကို rebuild လုပ်ပါ။ ယခင် Argon Medium ဟု ဖော်ပြထားသည့် နေရာများသည် မူလ version 0.6.0 အတွက် ဖြစ်ပါသည်။

# n8n + Server Gemini browser တပ်ဆင်ရန်

ဤဖိုင်များသည် **တပ်ဆင်ရန်ပြင်ဆင်ထားသော package** ဖြစ်ပါသည်။ Server မရှိသေးသဖြင့် deploy မလုပ်ထားပါ။ ဒီစက်တွင် Docker မရှိသဖြင့် container build နှင့် server ပေါ်က Google login ကို လက်တွေ့မစမ်းရသေးပါ။ n8n workflow ဖွဲ့စည်းပုံကို validator ဖြင့်စစ်ပြီး၊ server HTTP/job protocol နှင့် extension ချိတ်ဆက်မှုကို simulated browser ဖြင့် စမ်းထားပါသည်။ Google သည် server browser login ကို ငြင်းနိုင်သောကြောင့် တပ်ဆင်ပြီးမှ အမှန်တကယ် login ဝင်နိုင်မနိုင် စစ်ရပါမည်။

```text
Udemy extension → n8n webhook → server browser → Gemini Pro / Argon Medium
                ← job status + complete translated SRT ←
```

SRT တစ်ဖိုင်လုံးကို တစ်ကြိမ်တည်းတင်ပါသည်။ အပိုင်းလိုက်မပို့ပါ။ အဖြေအကုန်ရပြီး စာတန်းအရေအတွက်၊ နံပါတ်နှင့် မူရင်း timestamp အားလုံးမှန်မှ extension တွင် ပြပါသည်။ Gemini translation API မသုံးပါ။ n8n နှင့် worker ချိတ်ဆက်ရန် token နှစ်ခုသာ သုံးပါသည်။

## ၁။ Server ပြင်ဆင်ရန်

Linux server တစ်လုံးတွင် Docker Engine၊ Docker Compose plugin၊ OpenSSL နှင့် SSH သုံးနိုင်ရန် လိုပါသည်။ Browser နှင့် n8n အတွက် အစစမ်းသပ်ရန် RAM 4 GB ခန့်ရှိသော စက်ကို သတ်မှတ်ထားနိုင်ပြီး အမှန်တကယ်အသုံးပြုမှုပေါ်မူတည်၍ ချိန်ညှိပါ။

Project **တစ်ခုလုံး** ကို server သို့ကူးပါ။ `server/` folder တစ်ခုတည်းကူးလျှင် မရပါ။ Shared subtitle parser နှင့် Gemini browser adapter ကိုလည်း Docker build က သုံးပါသည်။ `.env`၊ browser profile နှင့် Google cookies များကို project archive ထဲ မထည့်ပါနှင့်။

ဥပမာ `/opt/udemy` သို့ ကူးထားလျှင်—

```sh
cd /opt/udemy/server
sh setup.sh
docker compose up -d --build
```

`setup.sh` က Pro အကောင့် email မေးပြီး `.env` ထဲတွင် token နှင့် password များကို ကျပန်းထုတ်သိမ်းပါသည်။ ရှိပြီးသား `.env` ကို ထပ်မရေးပါ။ Server browser အသစ်မှာ Pro အကောင့်တစ်ခုတည်း login ဝင်ရန် account index ကို `0` ထားပါသည်။ Google URL က `/u/1/` စသည်ဖြစ်ပါက `.env` မှ `GEMINI_ACCOUNT_INDEX` ကို လိုက်ပြောင်းပြီး `docker compose up -d` ပြန်လုပ်ပါ။ ဒီစက်ပေါ်က account index `2` ကို server ပေါ်မှာ အလိုအလျောက်မကူးပါ။

Chromium ကို non-root user၊ sandbox နှင့် official Playwright seccomp profile ဖြင့် run ပါသည်။ `seccomp_profile.json` နှင့် `PLAYWRIGHT-LICENSE` သည် Microsoft Playwright v1.64.1 မှ ဖြစ်ပါသည်။

## ၂။ Server browser မှာ Pro အကောင့်ဝင်ရန်

သင့်ကွန်ပျူတာ terminal မှ SSH tunnel ဖွင့်ပါ—

```sh
ssh -N -L 6080:127.0.0.1:6080 -L 5678:127.0.0.1:5678 user@SERVER_IP
```

Browser မှ `http://localhost:6080/vnc.html` ဖွင့်ပြီး Connect နှိပ်ပါ။ `.env` ရှိ `VNC_PASSWORD` ကို သုံးပါ။ Server desktop ပေါ်က Chromium မှာ သင့် Pro အကောင့် login ဝင်ပါ။ Password၊ 2FA နှင့် CAPTCHA ကို သင်ကိုယ်တိုင် ဖြည့်ပါ။ Account email မှန်ကြောင်းနှင့် **Argon Medium** ကို ရွေးနိုင်ကြောင်း စစ်ပါ။

Browser profile ကို `browser-data` Docker volume ထဲမှာ သိမ်းထားသဖြင့် container ပြန်စလျှင် login ဆက်ရှိနိုင်ပါသည်။ Google က session ပြန်စစ်ခိုင်းလျှင် ဒီ desktop ကနေ ပြန်ဝင်ပေးပါ။ Login ကို ကျော်လွှားခြင်း၊ CAPTCHA ဖြေခြင်းနှင့် password သိမ်းယူပေးခြင်းကို worker က မလုပ်ပါ။

noVNC နှင့် n8n ports ကို default အနေဖြင့် server localhost မှာသာ ဖွင့်ထားပါသည်။ Browser desktop port 6080 ကို အင်တာနက်သို့ တိုက်ရိုက်မဖွင့်ပါနှင့်။

## ၃။ n8n workflow ထည့်ရန်

SSH tunnel ဖွင့်ထားစဉ် `http://localhost:5678` သို့ဝင်ပါ။ ပထမဆုံး n8n owner account ကို သင်ကိုယ်တိုင် တည်ဆောက်ပါ။ ဒီ compose package သည် သင့်ရှိပြီးသား connected n8n ကို ပြောင်းလဲမထားပါ။

`n8n-workflow.json` ကို **Import from file** ဖြင့် ထည့်ပါ။ Node နှစ်ခုမှာ credential ရွေးပေးရန် လိုပါသည်။

1. **SRT commands** — Header Auth credential အသစ်တည်ဆောက်ပါ။ Name/header သည် `X-Udemy-Token`၊ value သည် `.env` ရှိ `WEBHOOK_TOKEN` ဖြစ်ပါသည်။
2. **Server Gemini browser** — `httpTemplatedCustomAuth` credential ကို တည်ဆောက်ပြီး template ကို အောက်ပါအတိုင်း သတ်မှတ်ပါ။ `api_key` value အဖြစ် `.env` ရှိ `RUNNER_TOKEN` ကို ထည့်ပါ။

```json
{"headers":{"Authorization":"Bearer {{api_key}}"}}
```

Token တန်ဖိုးများကို workflow node parameters၊ URLs၊ screenshots သို့မဟုတ် chat ထဲ မရေးပါနှင့်။ Credential manager ထဲတွင်သာ ထည့်ပါ။ Workflow တွင် execution payload သိမ်းခြင်းကို ပိတ်ထားသဖြင့် subtitle နှင့် token ကို execution history ထဲ မသိမ်းပါ။

Credential နှစ်ခုရွေးပြီးနောက် workflow ကို Save / Publish လုပ်ပါ။ Production webhook သည်—

```text
http://localhost:5678/webhook/udemy-srt
```

Worker URL `http://browser:3000/action` သည် compose network အတွင်းသုံးရန်ဖြစ်ပါသည်။ n8n Cloud သို့မဟုတ် အခြားစက်က n8n တွင် workflow ကိုထည့်မည်ဆိုလျှင် worker ကို အဲဒီ n8n က လုံခြုံစွာချိတ်နိုင်သော HTTPS/private network လမ်းကြောင်း ပေးပြီး HTTP node URL ကို ပြောင်းရန်လိုပါသည်။ `browser` hostname ကို အင်တာနက်ပေါ်မှ ချိတ်မရပါ။

## ၄။ Extension ချိတ်ရန်

Extension နှင့် Udemy စာမျက်နှာကို Reload လုပ်ပါ။ Extension popup မှ **n8n server — Gemini web on server** ကို ရွေးပါ။

- Webhook URL: `http://localhost:5678/webhook/udemy-srt`
- Access token: `.env` ရှိ `WEBHOOK_TOKEN`
- **Save n8n connection** နှိပ်ပြီး သတ်မှတ်ထားသော n8n host ကို အသုံးပြုခွင့်ပေးပါ။

Udemy panel တွင် **n8n server — full SRT** ရွေးပြီး Translate နှိပ်ပါ။ ဒီကွန်ပျူတာမှာ Gemini tab မဖွင့်ပါ။ Server browser ကို worker က ဖွင့်ပြီး ဘာသာပြန်ပေးပါသည်။ အကုန်ပြီးမှ **စာတန်းထိုး အသင့်ဖြစ်ပြီ** ဆိုသော notice ပေါ်ပါမည်။

ဒီ localhost ပုံစံတွင် SSH tunnel ကို ဆက်ဖွင့်ထားရန်လိုပါသည်။ Gemini tab ဖွင့်ထားစရာ မလိုပါ။

## ၅။ SSH tunnel အမြဲမဖွင့်ချင်လျှင် HTTPS domain သုံးရန်

သင့် domain DNS ကို server IP သို့ညွှန်းပြီး port 80 / 443 ကို ဖွင့်ပါ။ `.env` တွင် ဥပမာ `N8N_DOMAIN=n8n.example.com` ထည့်ပြီး—

```sh
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

Caddy က domain အတွက် HTTPS certificate ရယူပေးပါသည်။ Extension webhook URL ကို `https://n8n.example.com/webhook/udemy-srt` ပြောင်းသိမ်းပါ။ n8n editor account နှင့် webhook token ကို ဆက်သုံးပါ။ Browser login desktop ကိုတော့ လိုအပ်ချိန်တွင် SSH tunnel မှသာ ဖွင့်ပါ။

## အသုံးပြုမှုနှင့် ကန့်သတ်ချက်များ

- Server တစ်လုံးတွင် အလုပ်တစ်ခုစီ အစဉ်လိုက်လုပ်ပြီး အများဆုံး 20 ခုအထိ လက်ခံထားနိုင်ပါသည်။
- လုပ်ငန်း ID တူနှင့် SRT တူ ပြန်ပို့လျှင် အဲဒီအလုပ်ကိုသာ ပြန်ပေးပြီး ထပ်မဘာသာပြန်ပါ။ ID တူ၊ SRT မတူလျှင် ပယ်ပါသည်။
- **Stop** သို့မဟုတ် သင်ခန်းစာပြောင်းလျှင် ပြန်လာသောရလဒ်အဟောင်းကို မပြပါ။ Gemini သို့တင်ပြီးသားဖိုင်ကို Stop က ပြန်မရုပ်သိမ်းနိုင်ပါ။
- Server ပြန်စလျှင် လုပ်နေဆဲအလုပ်ကို error အဖြစ်ပြပြီး ဖိုင်ကို အလိုအလျောက်ထပ်မပို့ပါ။ Udemy မှ ပြန်စမ်းနိုင်ပါသည်။
- Result ကို server တွင် 24 နာရီ ထိန်းထားပြီး တစ်မိနစ်တစ်ကြိမ် maintenance တွင် expired jobs များရှင်းပါသည်။ Extension cache ကတော့ စက်ပေါ်တွင် ဆက်ရှိပါသည်။
- အလုပ်တစ်ခုအတွက် အများဆုံး မိနစ် 20 စောင့်ပါသည်။ Pro quota၊ အဖြေအရှည်ကန့်သတ်ချက်နှင့် Google website UI ပြောင်းလဲမှုတို့ သက်ရောက်ပါသည်။
- Browser mode များသည် Gemini web UI ကို သုံးပါသည်။ Website ပြောင်းလျှင် `gemini-browser.js` adapter ကို ပြင်ပြီး image ပြန် build လုပ်ရန်လိုနိုင်ပါသည်။
- Docker volume `browser-data` တွင် signed-in Google session ပါပါသည်။ ကိုယ်ပိုင် server ပေါ်မှာသာ ထားပါ။ `docker compose down -v` သည် login/session/data များ ဖျက်သွားမည်ဖြစ်သဖြင့် သာမန် restart အတွက် မသုံးပါနှင့်။

စစ်ဆေးရန် `docker compose logs --tail 50 browser` နှင့် `docker compose logs --tail 50 n8n` ကို သုံးနိုင်ပါသည်။ Log ကို အခြားသူထံမပို့မီ personal data မပါကြောင်း စစ်ပါ။

ရည်ညွှန်းချက်များ — [n8n Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/), [Playwright Docker](https://playwright.dev/docs/docker), [Playwright authentication](https://playwright.dev/docs/auth)။
