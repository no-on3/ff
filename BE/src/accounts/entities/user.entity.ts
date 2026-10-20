import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** A person who logs in through Keycloak: created on their first authenticated call (D2). */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The access token's subject: Keycloak's user ID. */
  @Column({ type: 'text', unique: true })
  oidcSub: string;

  @Column({ type: 'text' })
  email: string;

  @Column({ type: 'text', nullable: true })
  name: string | null;

  @Column({ type: 'text', default: 'fr-TN' })
  locale: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
