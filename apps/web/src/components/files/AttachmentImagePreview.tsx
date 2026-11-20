import { Modal } from '../base/Modal.js'
import styles from './AttachmentImagePreview.module.css'

export const AttachmentImagePreview = ({ url, name, onClose }: {
  url: string
  name: string
  onClose: () => void
}) => (
  <Modal title={name} onClose={onClose} closable className={styles.dialog}>
    <img className={styles.image} src={url} alt={name} />
  </Modal>
)
