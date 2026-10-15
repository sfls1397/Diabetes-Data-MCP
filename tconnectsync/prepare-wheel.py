#!/usr/bin/env python3
"""Change only the verified upstream wheel's obsolete PyJWT requirement."""
import base64
import csv
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile


def prepare(source, destination, profile):
    source, destination = Path(source), Path(destination)
    if hashlib.sha256(source.read_bytes()).hexdigest() != profile['wheel']['sha256']:
        raise RuntimeError('tconnectsync upstream wheel checksum mismatch')
    with zipfile.ZipFile(source) as wheel:
        names = wheel.namelist()
        if len(names) != len(set(names)):
            raise RuntimeError('Duplicate upstream wheel member')
        metadata = 'tconnectsync-3.0.3.dist-info/METADATA'
        record = 'tconnectsync-3.0.3.dist-info/RECORD'
        files = {name: wheel.read(name) for name in names}
        before = b'Requires-Dist: PyJWT==2.8.0\n'
        after = ('Requires-Dist: PyJWT==' + profile['pyjwt'] + '\n').encode()
        if files[metadata].count(before) != 1:
            raise RuntimeError('Unexpected tconnectsync dependency metadata')
        files[metadata] = files[metadata].replace(before, after)
        output = io.StringIO(newline='')
        writer = csv.writer(output, lineterminator='\n')
        for name in names:
            if name == record:
                writer.writerow([name, '', ''])
            else:
                data = files[name]
                digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
                writer.writerow([name, 'sha256=' + digest, len(data)])
        files[record] = output.getvalue().encode()
        destination.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(destination, 'w') as repaired:
            for member in wheel.infolist():
                repaired.writestr(member, files[member.filename])
    print('Verified tconnectsync wheel dependency metadata repaired; application bytes unchanged')


if __name__ == '__main__':
    prepare(sys.argv[1], sys.argv[2], json.loads(Path(sys.argv[3]).read_text()))
