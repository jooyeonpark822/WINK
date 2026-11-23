"""노트북 서버용 USB 시리얼 읽기 프로그램.

브릿지 보드(USB 시리얼)에서 온 바이트를 표준출력으로 그대로 흘려보낸다. bridgeSerial.js가 이 프로그램을 띄우고 프레임을 해석한다.
(node의 serialport는 Windows에서 초당 16KB쯤에서 막혀 소리가 대부분 사라져서, 읽기만 파이썬 pyserial로 한다. 시험: 초당 약 780KB)

상태는 표준에러로 한 줄씩 알린다:  OPEN <포트> | CLOSED | WAIT <이유>
포트는 --port 로 정하고, 없으면 Espressif(ESP32, VID 303A) 보드를 자동으로 찾는다. 끊기면 2초마다 다시 찾는다.
"""
import argparse
import sys
import time

import serial
from serial.tools import list_ports

ESPRESSIF_VID = 0x303A
RETRY_S = 2.0


def say(msg):
    print(msg, file=sys.stderr, flush=True)


def find_port(wanted):
    if wanted:
        return wanted
    ports = [p.device for p in list_ports.comports() if p.vid == ESPRESSIF_VID]
    if len(ports) > 1:
        say(f'WAIT ESP32 보드가 {len(ports)}개 보여서 {ports[0]}를 씁니다. 다르면 server/.env에 SERIAL_PORT=COM번호 를 적어 주세요.')
    return ports[0] if ports else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port')
    args = ap.parse_args()
    out = sys.stdout.buffer

    while True:
        port = find_port(args.port)
        if not port:
            say('WAIT 브릿지 보드(USB)를 찾지 못했습니다. 연결하면 자동으로 이어집니다.')
            time.sleep(RETRY_S)
            continue
        try:
            # 포트를 여는 순간 DTR/RTS가 켜지면 ESP32 보드가 재시작된다. (그러면 Wi-Fi가 끊겨 안경/컨트롤러가 다시 붙어야 한다)
            # 열기 전에 둘 다 꺼 둔 상태로 열어서 보드를 건드리지 않는다.
            ser = serial.Serial()
            ser.port = port
            ser.baudrate = 115200
            ser.timeout = 0.05
            ser.dtr = False
            ser.rts = False
            ser.open()
        except (serial.SerialException, OSError) as e:
            say(f'WAIT {port}를 열지 못했습니다: {e} (다른 프로그램이 쓰고 있으면 닫아 주세요)')
            time.sleep(RETRY_S)
            continue
        say(f'OPEN {port}')
        try:
            while True:
                data = ser.read(max(ser.in_waiting, 1))
                if data:
                    out.write(data)
                    out.flush()
        except (serial.SerialException, OSError):
            pass
        finally:
            try:
                ser.close()
            except Exception:
                pass
        say('CLOSED')
        time.sleep(RETRY_S)


if __name__ == '__main__':
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        pass
