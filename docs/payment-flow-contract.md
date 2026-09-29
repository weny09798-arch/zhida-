# 支付后订单号与金额采集约定

实施前文件校验（SHA256，未改这些文件之前）：

- manifest.json `D598824E6787299964AA88F6E20B3110DE0B9F1CB7B3C9D609E1208876E5E244`
- background.js `E39EFB18F30DB052E9081243EF3E972F881D7B6E7CEB1BB5D88DB66BD822346E`
- pdd_order.js `73220DE456006AB8F2CD836B02E8F9466C33D1F04D4C7F90E34B43AB1FDE4961`
- platform-collectors.js `983BB006F43380277E99FD647F8DEBBEBAA080A13BD80B41C177706DE5D6059E`
- purchase-store.js `4D246ED1D1C48894436E50EAD75E5250C33B292DF85DE544D8AF12FA0674747C`
- sync-queue.js `301637702320B6787D0F2AE895624B8464591A7BF2CCC7FDE57AFB554CA3EA5F`
- content.js `9AD934CFB880F3D1E3AAA5D018D1D43E5DCDA533FB5864554666B34BBD595BA5`

## 已确认

- 付款由用户在支付宝完成。插件不自动付款，不重复提交订单。
- 支付宝结果页样例地址形态是 `https://mclient.alipay.com/h5pay/cashierActivity/index.html`。用户看到“支付成功”和金额，页面上没有拼多多订单号。
- 拼多多路径按页面类型识别：`index.html`、`personal.html`、`orders.html`。不保存、不复用某一次访问的 `refer_page_id` 等来源参数。
- 物流页 `goods_express.html` 只用于已有订单号之后的快递采集，不当作实付金额的已验证来源。
- 正式采购订单号来自待发货列表进入的订单详情，并经匹配规则确认后才写入 `platformOrderSn`。
- 支付宝金额写入 `paymentReceipt`。订单详情实付写入 `amount`。两者不一致时保留来源并标成待核对。

## 尚未用登录账号验证

本次没有打开用户已登录的拼多多或支付宝页面采样 DOM。因此：

- 个人中心、待发货卡片、订单详情里的具体选择器都还不能标为已验证。
- 只读采集页如果认不出“个人中心”或“待发货”控件，会停下来说明页面未识别，不会按列表顺序认领。
- `tests/fixtures/payment/` 里的文本是根据实施计划整理的脱敏样例，不是登录后抓下来的页面。
