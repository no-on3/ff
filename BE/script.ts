
import * as Hostel from '@chatsight/hostel';



const a =new Hostel.default({
    connection: {
      hostname: 'localhost',
      port: 4646,
      sslEnabled: false,
      ssl: {
        ca: ('nomad.ssl.ca'),
        cert: ('nomad.ssl.cert'),
        privateKey: ('nomad.ssl.key'),
      },
      ignoreTLSWarning: true
    }
  }) 
console.log(a);