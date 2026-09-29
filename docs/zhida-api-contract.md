# 至达回传接口（本次已核实范围）

本次没有新的接口文档，也没有用假单号去打后台。代码只继续调用插件里原来就有的接口。

- 地址：`POST https://zhida.shopeeok.com/agent-foreign/order/addExpress`
- `orderId`：至达订单内部 ID（订单列表里的 `id`）
- `itemId`：至达商品行内部 ID（商品行里的 `id`）
- `shoppingNum`：拼多多采购订单号
- `trackingNo`：快递单号
- `shoppingPrice`：这笔采购的实付总额，单位元，字符串，例如 `19.80`。没有采到实付时传空字符串，不传 `0`
- `sendQuantity`：购买数量

没有运单号时不调用这个接口。金额先记在浏览器本地，面板写明「本地已记录，后台待物流同步」。成功只认 HTTP 200 且 `body.success === true`。登录失效、拒绝、响应丢失都不会显示成已回传。
