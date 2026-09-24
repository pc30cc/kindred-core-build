#!/usr/bin/env python3
"""
TEST ONLY: what a merchant's unzip / FTP upload does — extract a package over
the installed files KEEPING the dates stored in the zip (the packages carry a
fixed date), optionally with a marker appended to the admin template so a
test can tell the new page from a stale compiled one.

    copy_over.py extract <zip> <dest_dir> [marker]
    copy_over.py mark <zip> <out_zip> <marker>
"""
import os, sys, time, zipfile

TEMPLATES = ('admin/view/template/module/webyar.twig', 'admin/view/template/extension/module/webyar.twig')


def data_for(z, info, marker):
    data = z.read(info)
    if marker and info.filename.endswith(TEMPLATES):
        data += f'\n<!-- {marker} -->\n'.encode()
    return data


def extract(zip_path, dest, marker=None):
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            target = os.path.join(dest, info.filename)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as fh:
                fh.write(data_for(z, info, marker))
            stamp = time.mktime(info.date_time + (0, 0, -1))
            os.utime(target, (stamp, stamp))


def mark(zip_path, out, marker):
    with zipfile.ZipFile(zip_path) as z, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as o:
        for info in z.infolist():
            o.writestr(info, data_for(z, info, marker))


if __name__ == '__main__':
    if sys.argv[1] == 'extract':
        extract(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
    else:
        mark(sys.argv[2], sys.argv[3], sys.argv[4])
