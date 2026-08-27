# Implementation shape: extend bridge vs separate plugin

Type: grilling
Status: open
Blocked by: 02

## Question

交互处理逻辑应放在现有 `TelegramBridge` 内，还是拆成独立 Cordis 插件（仅注册 provider/answerer，复用 bridge 的 client 发送能力）？权衡：测试隔离、cordis.yml 组合复杂度、与 workspace/skill picker 的状态共享。

## Comments
