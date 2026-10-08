import struct, sys
path, dylib = sys.argv[1], sys.argv[2].encode()
data = bytearray(open(path, 'rb').read())

def patch_slice(off):
    magic, cpu, sub, ftype, ncmds, sizeofcmds, flags = struct.unpack_from('<7I', data, off)
    assert magic == 0xfeedfacf, hex(magic)
    hdr = 32
    p = off + hdr; min_sect = None
    for _ in range(ncmds):
        cmd, csize = struct.unpack_from('<2I', data, p)
        if cmd == 0xC and dylib in bytes(data[p+24:p+csize]):
            print('already present'); return
        if cmd == 0x19:  # LC_SEGMENT_64
            nsects = struct.unpack_from('<I', data, p+64)[0]
            for s in range(nsects):
                so = p + 72 + s*80
                foff = struct.unpack_from('<I', data, so+48)[0]
                if foff and (min_sect is None or foff < min_sect): min_sect = foff
        p += csize
    name = dylib + b'\0'
    lc_size = (24 + len(name) + 7) & ~7
    end = off + hdr + sizeofcmds
    assert off + min_sect - end >= lc_size, 'not enough header padding'
    assert not any(data[end:end+lc_size])
    lc = struct.pack('<6I', 0xC, lc_size, 24, 2, 0x10000, 0x10000) + name
    data[end:end+lc_size] = lc.ljust(lc_size, b'\0')
    struct.pack_into('<2I', data, off+16, ncmds+1, sizeofcmds+lc_size)
    print('patched slice at', off, 'padding left', off + min_sect - end - lc_size)

if struct.unpack_from('>I', data, 0)[0] == 0xcafebabe:
    n = struct.unpack_from('>I', data, 4)[0]
    for i in range(n):
        patch_slice(struct.unpack_from('>5I', data, 8+i*20)[2])
else:
    patch_slice(0)
open(path, 'wb').write(data)
