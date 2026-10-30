import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { DomainStatus } from '../custom-domain.entity';

/** POST /functions/{id}/url/domains: a domain of the account's, for the function's URL. */
export class AddCustomDomainDto {
  @ApiProperty({ example: 'shop.example.tn', description: 'A name of two labels at least, a domain apex too; in lower case or not, with a final dot or not' })
  @IsString()
  @Length(1, 254)
  domain: string;
}

/** A DNS record to make at the domain's DNS provider. */
export class DomainRecordView {
  @ApiProperty({ enum: ['CNAME', 'TXT', 'A', 'AAAA'] })
  type: 'CNAME' | 'TXT' | 'A' | 'AAAA';

  @ApiProperty({ example: 'shop.example.tn' })
  name: string;

  @ApiProperty({ example: '0123456789abcdefghijklmnopqrstuv.fn.example.tn' })
  value: string;
}

/** The two ways to prove the domain: either set of records. */
export class DomainRecordsView {
  @ApiProperty({ type: [DomainRecordView], description: "For a subdomain: a CNAME to the URL's host" })
  cname: DomainRecordView[];

  @ApiProperty({ type: [DomainRecordView], description: "For any domain, an apex too: the TXT record with the domain's token, and the edge's addresses when FF names them" })
  txt: DomainRecordView[];
}

/** A custom domain, as the API answers it. */
export class CustomDomainView {
  @ApiProperty({ example: 'shop.example.tn' })
  domain: string;

  @ApiProperty()
  functionId: string;

  @ApiProperty({ enum: DomainStatus, description: 'pending until the DNS proves it; verified, it is served' })
  status: DomainStatus;

  @ApiProperty({ type: DomainRecordsView })
  records: DomainRecordsView;

  @ApiProperty({ nullable: true, type: Date, description: 'Its last check' })
  checkedAt: Date | null;

  @ApiProperty({ nullable: true, type: String, description: 'What its last check found wrong' })
  checkError: string | null;

  @ApiProperty({ nullable: true, type: Date })
  verifiedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

/** A customer's own domain for a bucket's site, as the API answers it. */
export class SiteDomainView {
  @ApiProperty({ example: 'www.shop.tn' })
  domain: string;

  @ApiProperty({ example: 'shop', description: 'The bucket whose site it serves' })
  bucket: string;

  @ApiProperty({ enum: DomainStatus, description: 'pending until the DNS proves it; verified, the site answers there' })
  status: DomainStatus;

  @ApiProperty({ type: DomainRecordsView, description: "For a subdomain, a CNAME to the site's host; for any domain, the TXT record with the edge's addresses" })
  records: DomainRecordsView;

  @ApiProperty({ nullable: true, type: Date, description: 'Its last check' })
  checkedAt: Date | null;

  @ApiProperty({ nullable: true, type: String, description: 'What its last check found wrong' })
  checkError: string | null;

  @ApiProperty({ nullable: true, type: Date })
  verifiedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}
