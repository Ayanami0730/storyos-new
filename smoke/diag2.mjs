import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
const BASE_URL = "https://ai-prod-sg.wenxiaobai.com/v1";
const model = { id:"gpt-5-mini", name:"m", api:"openai-completions", provider:"ys", baseUrl:BASE_URL, reasoning:true, input:["text"], cost:{input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow:400000, maxTokens:128000 };
const provider = createProvider({ id:"ys", name:"ys", baseUrl:BASE_URL, auth:{apiKey:envApiKeyAuth("ys",["YS_KEY"])}, models:[model], api:openAICompletionsApi() });
const models = createModels(); models.setProvider(provider);
const stream = models.stream(models.getModel("ys","gpt-5-mini"), { systemPrompt:"terse", messages:[{role:"user",content:[{type:"text",text:"say ok"}]}], tools:[] }, {});
for await (const ev of stream) { if (ev.type==="error") console.log(JSON.stringify(ev.error, null, 1).slice(0,1500)); }
