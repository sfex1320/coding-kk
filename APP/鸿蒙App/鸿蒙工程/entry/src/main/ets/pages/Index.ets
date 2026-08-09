import { webview } from '@kit.ArkWeb';
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { promptAction } from '@kit.ArkUI';

// CodeStatus 鸿蒙手机端：扫描电脑端二维码后，用内置 WebView 加载副屏页面。
// 二维码内容形如 http://192.168.x.x:5173?display=1&pair=XXXXX
@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State url: string = 'about:blank';
  @State connected: boolean = false;

  scan() {
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.QR_CODE],
      enableMultiMode: true,
      enableAlbum: true
    };
    scanBarcode.startScanForResult(getContext(this), options)
      .then((result: scanBarcode.ScanResult) => {
        if (result && result.originalValue) {
          this.url = result.originalValue;
          this.connected = true;
        }
      })
      .catch(() => {
        promptAction.showToast({ message: '扫码已取消或失败' });
      });
  }

  build() {
    Stack() {
      if (this.connected) {
        Web({ src: this.url, controller: this.controller })
          .width('100%')
          .height('100%')
          .mixedMode(MixedMode.All)
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .databaseAccess(true)
      } else {
        Column({ space: 18 }) {
          Text('CodeStatus').fontSize(34).fontWeight(FontWeight.Bold).fontColor('#fff7ee')
          Text('扫描电脑端页面「局域网配对」二维码即可连接').fontSize(15).fontColor('#ffd5b2').textAlign(TextAlign.Center)
          Button('扫码连接').width(220).height(54).fontSize(18).fontColor('#2a1209').backgroundColor('#ffd56a')
            .onClick(() => this.scan())
        }
        .width('100%').height('100%').justifyContent(FlexAlign.Center).padding(28)
        .backgroundColor('#1a0f08')
      }
    }.width('100%').height('100%')
  }
}
