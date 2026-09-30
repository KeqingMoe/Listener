import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

// 出站下载（图片、群文件、网页）共用的SSRF防护：DNS解析结果必须全部是公网单播地址。

/** 拒绝非规范地址、带scope的IPv6、IPv4映射地址以及所有特殊用途网段。 */
export function isPublicAddress(address: string): boolean {
  if (!isIP(address) || address.includes('%')) {
    return false;
  }
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== 'unicast') {
      return false;
    }
    // IPv6全球单播目前为2000::/3。即使某些ipaddr.js版本把特殊用途分配标为普通unicast，也要排除。
    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6;
      if (!v6.match(ipaddr.parse('2000::') as ipaddr.IPv6, 3)) {
        return false;
      }
      for (const [network, prefix] of [
        ['2001::', 23],
        ['2001:db8::', 32],
        ['2002::', 16],
        ['3fff::', 20],
      ] as const) {
        if (v6.match(ipaddr.parse(network) as ipaddr.IPv6, prefix)) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}
